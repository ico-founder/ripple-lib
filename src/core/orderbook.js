// Routines for working with an orderbook.
//
// One OrderBook object represents one half of an order book. (i.e. bids OR
// asks) Which one depends on the ordering of the parameters.
//
// Events:
//  - model
//  - trade
//  - transaction

'use strict';

const _ = require('lodash');
const util = require('util');
const extend = require('extend');
const assert = require('assert');
const async = require('async');
const EventEmitter = require('events').EventEmitter;
const Amount = require('./amount').Amount;
const UInt160 = require('./uint160').UInt160;
const Currency = require('./currency').Currency;
const AutobridgeCalculator = require('./autobridgecalculator');
const OrderBookUtils = require('./orderbookutils');
const log = require('./log').internal.sub('orderbook');
const IOUValue = require('./IOUValue').IOUValue;

function assertValidNumber(number, message) {
  assert(!_.isNull(number) && !isNaN(number), message);
}

/**
 * @constructor OrderBook
 * @param {Remote} remote
 * @param {String} ask currency
 * @param {String} ask issuer
 * @param {String} bid currency
 * @param {String} bid issuer
 * @param {String} orderbook key
 */

function OrderBook(remote,
                   currencyGets, issuerGets, currencyPays, issuerPays,
                   key) {
  EventEmitter.call(this);

  const self = this;

  this._remote = remote;
  this._currencyGets = Currency.from_json(currencyGets);
  this._issuerGets = issuerGets;
  this._currencyPays = Currency.from_json(currencyPays);
  this._issuerPays = issuerPays;
  this._key = key;
  this._subscribed = false;
  this._shouldSubscribe = true;
  this._listeners = 0;
  this._offers = [];
  this._offersAutobridged = [];
  this._mergedOffers = [];
  this._offerCounts = {};
  this._ownerFundsUnadjusted = {};
  this._ownerFunds = {};
  this._ownerOffersTotal = {};

  // We consider ourselves synchronized if we have a current
  // copy of the offers, we are online and subscribed to updates
  this._synchronized = false;

  // Transfer rate of the taker gets currency issuer
  this._issuerTransferRate = null;

  // When orderbook is IOU/IOU, there will be IOU/XRP and XRP/IOU
  // books that we must keep track of to compute autobridged offers
  this._legOneBook = null;
  this._legTwoBook = null;

  this._isAutobridgeable = !this._currencyGets.is_native()
    && !this._currencyPays.is_native();

  function computeAutobridgedOffersWrapper() {
    self.computeAutobridgedOffers();
    self.mergeDirectAndAutobridgedBooks();
  }

  if (this._isAutobridgeable) {
    this._legOneBook = remote.createOrderBook({
      currency_gets: 'XRP',
      currency_pays: currencyPays,
      issuer_pays: issuerPays
    });

    this._legOneBook.on('model', computeAutobridgedOffersWrapper);

    this._legTwoBook = remote.createOrderBook({
      currency_gets: currencyGets,
      issuer_gets: issuerGets,
      currency_pays: 'XRP'
    });

    this._legTwoBook.on('model', computeAutobridgedOffersWrapper);
  }

  function listenersModified(action, event) {
    // Automatically subscribe and unsubscribe to orderbook
    // on the basis of existing event listeners
    if (_.contains(OrderBook.EVENTS, event)) {
      switch (action) {
        case 'add':
          if (++self._listeners === 1) {
            self.subscribe();
          }
          break;
        case 'remove':
          if (--self._listeners === 0) {
            self.unsubscribe();
          }
          break;
      }
    }
  }

  function updateFundedAmountsWrapper(transaction) {
    self.updateFundedAmounts(transaction);
  }

  this.on('newListener', function(event) {
    listenersModified('add', event);
  });

  this.on('removeListener', function(event) {
    listenersModified('remove', event);
  });

  this._remote.on('transaction', updateFundedAmountsWrapper);

  this.on('unsubscribe', function() {
    self.resetCache();

    self._remote.removeListener('transaction', updateFundedAmountsWrapper);
  });

  this._remote.once('prepare_subscribe', function() {
    self.subscribe();
  });

  this._remote.on('disconnect', function() {
    self.resetCache();
    self._remote.once('prepare_subscribe', function() {
      self.subscribe();
    });
  });

  return this;
}

util.inherits(OrderBook, EventEmitter);

/**
 * Events emitted from OrderBook
 */

OrderBook.EVENTS = [
  'transaction', 'model', 'trade',
  'offer_added', 'offer_removed',
  'offer_changed', 'offer_funds_changed'
];

OrderBook.DEFAULT_TRANSFER_RATE = 1000000000;

/**
 * Normalize offers from book_offers and transaction stream
 *
 * @param {Object} offer
 * @return {Object} normalized
 */

OrderBook.offerRewrite = function(offer) {
  const result = {};
  const keys = Object.keys(offer);

  for (let i = 0, l = keys.length; i < l; i++) {
    const key = keys[i];
    switch (key) {
      case 'PreviousTxnID':
      case 'PreviousTxnLgrSeq':
        break;
      default:
        result[key] = offer[key];
    }
  }

  result.Flags = result.Flags || 0;
  result.OwnerNode = result.OwnerNode || new Array(16 + 1).join('0');
  result.BookNode = result.BookNode || new Array(16 + 1).join('0');

  return result;
};

/**
 * Initialize orderbook. Get orderbook offers and subscribe to transactions
 */

OrderBook.prototype.subscribe = function() {
  const self = this;

  if (!this._shouldSubscribe) {
    return;
  }

  if (this._remote.trace) {
    log.info('subscribing', this._key);
  }

  const steps = [
    function(callback) {
      self.requestTransferRate(callback);
    },
    function(callback) {
      self.requestOffers(callback);
    },
    function(callback) {
      self.subscribeTransactions(callback);
    }
  ];

  async.series(steps);
};

/**
 * Unhook event listeners and prevent ripple-lib from further work on this
 * orderbook. There is no more orderbook stream, so "unsubscribe" is nominal
 */

OrderBook.prototype.unsubscribe = function() {
  const self = this;

  if (this._remote.trace) {
    log.info('unsubscribing', this._key);
  }

  this._subscribed = false;
  this._shouldSubscribe = false;

  OrderBook.EVENTS.forEach(function(event) {
    if (self.listeners(event).length > 0) {
      self.removeAllListeners(event);
    }
  });

  this.emit('unsubscribe');
};

/**
 * Request orderbook entries from server
 *
 * @param {Function} callback
 */

OrderBook.prototype.requestOffers = function(callback=function() {}) {
  const self = this;

  if (!this._shouldSubscribe) {
    return callback(new Error('Should not request offers'));
  }

  if (this._remote.trace) {
    log.info('requesting offers', this._key);
  }

  function handleOffers(res) {
    if (!Array.isArray(res.offers)) {
      // XXX What now?
      return callback(new Error('Invalid response'));
    }

    if (self._remote.trace) {
      log.info('requested offers', self._key, 'offers: ' + res.offers.length);
    }

    self.setOffers(res.offers);
    self._synchronized = true;
    self.notifyDirectOffersChanged();

    callback(null, self._offers);
  }

  function handleError(err) {
    // XXX What now?
    if (self._remote.trace) {
      log.info('failed to request offers', self._key, err);
    }

    callback(err);
  }

  const request = this._remote.requestBookOffers(this.toJSON());
  request.once('success', handleOffers);
  request.once('error', handleError);
  request.request();

  return request;
};

/**
 * Request transfer rate for this orderbook's issuer
 *
 * @param {Function} callback
 */

OrderBook.prototype.requestTransferRate = function(callback) {
  assert.strictEqual(typeof callback, 'function');

  const self = this;

  if (this._currencyGets.is_native()) {
    // Transfer rate is default for the native currency
    this._issuerTransferRate = OrderBook.DEFAULT_TRANSFER_RATE;

    return callback(null, OrderBook.DEFAULT_TRANSFER_RATE);
  }

  if (this._issuerTransferRate) {
    // Transfer rate has already been cached
    return callback(null, this._issuerTransferRate);
  }

  function handleAccountInfo(err, info) {
    if (err) {
      return callback(err);
    }

    // When transfer rate is not explicitly set on account, it implies the
    // default transfer rate
    self._issuerTransferRate = info.account_data.TransferRate ||
                               OrderBook.DEFAULT_TRANSFER_RATE;

    callback(null, self._issuerTransferRate);
  }

  this._remote.requestAccountInfo(
    {account: this._issuerGets},
    handleAccountInfo
  );
};

/**
 * Subscribe to transactions stream
 *
 * @param {Function} callback
 */

OrderBook.prototype.subscribeTransactions = function(callback) {
  const self = this;

  if (!this._shouldSubscribe) {
    return callback('Should not subscribe');
  }

  if (this._remote.trace) {
    log.info('subscribing to transactions');
  }

  function handleSubscribed(res) {
    if (self._remote.trace) {
      log.info('subscribed to transactions');
    }

    self._subscribed = true;

    callback(null, res);
  }

  function handleError(err) {
    if (self._remote.trace) {
      log.info('failed to subscribe to transactions', self._key, err);
    }

    callback(err);
  }

  const request = this._remote.requestSubscribe();
  request.addStream('transactions');
  request.once('success', handleSubscribed);
  request.once('error', handleError);
  request.request();

  return request;
};

/**
 * Handles notifying listeners that direct offers have changed. For autobridged
 * books, an additional merge step is also performed
 */

OrderBook.prototype.notifyDirectOffersChanged = function() {
  if (this._isAutobridgeable) {
    this.mergeDirectAndAutobridgedBooks();
  } else {
    this.emit('model', this._offers);
  }
};

/**
 * Reset cached owner's funds, offer counts, and offer sums
 */

OrderBook.prototype.resetCache = function() {
  this._ownerFunds = {};
  this._ownerOffersTotal = {};
  this._offerCounts = {};
  this._synchronized = false;
};

/**
 * Check whether owner's funds have been cached
 *
 * @param {String} account - owner's account address
 */

OrderBook.prototype.hasOwnerFunds = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  return this._ownerFunds[account] !== undefined;
};

/**
 * Set owner's, transfer rate adjusted, funds in cache
 *
 * @param {String} account - owner's account address
 * @param {String} fundedAmount
 */

OrderBook.prototype.setOwnerFunds = function(account, fundedAmount) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  assert(!isNaN(fundedAmount), 'Funded amount is invalid');

  this._ownerFundsUnadjusted[account] = fundedAmount;
  this._ownerFunds[account] = this.applyTransferRate(fundedAmount);
};

/**
 * Compute adjusted balance that would be left after issuer's transfer fee is
 * deducted
 *
 * @param {String} balance
 * @return {String}
 */

OrderBook.prototype.applyTransferRate = function(balance) {
  assert(!isNaN(balance), 'Balance is invalid');
  assertValidNumber(this._issuerTransferRate, 'Transfer rate is invalid');

  const adjustedBalance = (new IOUValue(balance))
  .divide(new IOUValue(this._issuerTransferRate))
  .multiply(new IOUValue(OrderBook.DEFAULT_TRANSFER_RATE)).toString();

  return adjustedBalance;
};

/**
 * Get owner's cached, transfer rate adjusted, funds
 *
 * @param {String} account - owner's account address
 * @return {Amount}
 */

OrderBook.prototype.getOwnerFunds = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  if (this.hasOwnerFunds(account)) {
    if (this._currencyGets.is_native()) {
      return Amount.from_json(this._ownerFunds[account]);
    }
    return OrderBookUtils.normalizeAmount(this._ownerFunds[account]);
  }
};

/**
 * Get owner's cached unadjusted funds
 *
 * @param {String} account - owner's account address
 * @return {String}
 */

OrderBook.prototype.getUnadjustedOwnerFunds = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  return this._ownerFundsUnadjusted[account];
};

/**
 * Remove cached owner's funds
 *
 * @param {String} account - owner's account address
 */

OrderBook.prototype.deleteOwnerFunds = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  this._ownerFunds[account] = undefined;
};

/**
 * Get offer count for owner
 *
 * @param {String} account - owner's account address
 * @return {Number}
 */

OrderBook.prototype.getOwnerOfferCount = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  return this._offerCounts[account] || 0;
};

/**
 * Increment offer count for owner
 *
 * @param {String} account - owner's account address
 * @return {Number}
 */

OrderBook.prototype.incrementOwnerOfferCount = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  const result = (this._offerCounts[account] || 0) + 1;
  this._offerCounts[account] = result;
  return result;
};

/**
 * Decrement offer count for owner
 * When an account has no more orders, we also stop tracking their account funds
 *
 * @param {String} account - owner's account address
 * @return {Number}
 */

OrderBook.prototype.decrementOwnerOfferCount = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  const result = (this._offerCounts[account] || 1) - 1;
  this._offerCounts[account] = result;

  if (result < 1) {
    this.deleteOwnerFunds(account);
  }

  return result;
};

/**
 * Add amount sum being offered for owner
 *
 * @param {String} account - owner's account address
 * @param {Object|String} amount - offer amount as native string or IOU
 *                                 currency format
 * @return {Amount}
 */

OrderBook.prototype.addOwnerOfferTotal = function(account, amount) {
  assert(UInt160.is_valid(account), 'Account is invalid');

  const previousAmount = this.getOwnerOfferTotal(account);
  const currentAmount = previousAmount.add(Amount.from_json(amount));

  this._ownerOffersTotal[account] = currentAmount;

  return currentAmount;
};

/**
 * Subtract amount sum being offered for owner
 *
 * @param {String} account - owner's account address
 * @param {Object|String} amount - offer amount as native string or IOU
 *                                 currency format
 * @return {Amount}
 */

OrderBook.prototype.subtractOwnerOfferTotal = function(account, amount) {
  assert(UInt160.is_valid(account), 'Account is invalid');

  const previousAmount = this.getOwnerOfferTotal(account);
  const newAmount = previousAmount.subtract(Amount.from_json(amount));
  this._ownerOffersTotal[account] = newAmount;

  assert(!newAmount.is_negative(), 'Offer total cannot be negative');

  return newAmount;
};

/**
 * Get offers amount sum for owner
 *
 * @param {String} account - owner's account address
 * @return {Amount}
 */

OrderBook.prototype.getOwnerOfferTotal = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  const amount = this._ownerOffersTotal[account];
  if (amount) {
    return amount;
  }
  if (this._currencyGets.is_native()) {
    return Amount.from_json('0');
  }
  return OrderBookUtils.normalizeAmount('0');
};

/**
 * Reset offers amount sum for owner to 0
 *
 * @param {String} account - owner's account address
 * @return {Amount}
 */

OrderBook.prototype.resetOwnerOfferTotal = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  if (this._currencyGets.is_native()) {
    this._ownerOffersTotal[account] = Amount.from_json('0');
  } else {
    this._ownerOffersTotal[account] = OrderBookUtils.normalizeAmount('0');
  }
};

/**
 * Set funded amount on offer with its owner's cached funds
 *
 * is_fully_funded indicates if these funds are sufficient for the offer placed.
 * taker_gets_funded indicates the amount this account can afford to offer.
 * taker_pays_funded indicates adjusted TakerPays for partially funded offer.
 *
 * @param {Object} offer
 * @return offer
 */

OrderBook.prototype.setOfferFundedAmount = function(offer) {
  assert.strictEqual(typeof offer, 'object', 'Offer is invalid');

  const fundedAmount = this.getOwnerFunds(offer.Account);
  const previousOfferSum = this.getOwnerOfferTotal(offer.Account);
  const currentOfferSum = previousOfferSum.add(
    Amount.from_json(offer.TakerGets));

  offer.owner_funds = this.getUnadjustedOwnerFunds(offer.Account);

  offer.is_fully_funded = fundedAmount.compareTo(currentOfferSum) >= 0;

  if (offer.is_fully_funded) {
    offer.taker_gets_funded = Amount.from_json(offer.TakerGets).to_text();
    offer.taker_pays_funded = Amount.from_json(offer.TakerPays).to_text();
  } else if (previousOfferSum.compareTo(fundedAmount) < 0) {
    offer.taker_gets_funded = fundedAmount.subtract(previousOfferSum).to_text();

    const quality = OrderBookUtils.getOfferQuality(offer, this._currencyGets);
    const takerPaysFunded = quality.multiply(
      OrderBookUtils.getOfferTakerGetsFunded(offer)
    );

    offer.taker_pays_funded = this._currencyPays.is_native()
      ? String(Math.floor(takerPaysFunded.to_number()))
      : takerPaysFunded.to_json().value;
  } else {
    offer.taker_gets_funded = '0';
    offer.taker_pays_funded = '0';
  }

  return offer;
};

/**
 * Get account and final balance of a meta node
 *
 * @param {Object} node - RippleState or AccountRoot meta node
 * @return {Object}
 */

OrderBook.prototype.parseAccountBalanceFromNode = function(node) {
  const result = {
    account: undefined,
    balance: undefined
  };

  switch (node.entryType) {
    case 'AccountRoot':
      result.account = node.fields.Account;
      result.balance = node.fieldsFinal.Balance;
      break;

    case 'RippleState':
      if (node.fields.HighLimit.issuer === this._issuerGets) {
        result.account = node.fields.LowLimit.issuer;
        result.balance = node.fieldsFinal.Balance.value;
      } else if (node.fields.LowLimit.issuer === this._issuerGets) {
        result.account = node.fields.HighLimit.issuer;

        // Negate balance on the trust line
        result.balance = Amount.from_json(
          node.fieldsFinal.Balance
        ).negate().to_json().value;
      }
      break;
  }

  assert(!isNaN(result.balance), 'node has an invalid balance');
  assert(UInt160.is_valid(result.account), 'node has an invalid account');

  return result;
};

/**
 * Check that affected meta node represents a balance change
 *
 * @param {Object} node - RippleState or AccountRoot meta node
 * @return {Boolean}
 */

OrderBook.prototype.isBalanceChangeNode = function(node) {
  // Check meta node has balance, previous balance, and final balance
  if (!(node.fields && node.fields.Balance
  && node.fieldsPrev && node.fieldsFinal
  && node.fieldsPrev.Balance && node.fieldsFinal.Balance)) {
    return false;
  }

  // Check if taker gets currency is native and balance is not a number
  if (this._currencyGets.is_native()) {
    return !isNaN(node.fields.Balance);
  }

  // Check if balance change is not for taker gets currency
  if (node.fields.Balance.currency !== this._currencyGets.to_json()) {
    return false;
  }

  // Check if trustline does not refer to the taker gets currency issuer
  if (!(node.fields.HighLimit.issuer === this._issuerGets
     || node.fields.LowLimit.issuer === this._issuerGets)) {
    return false;
  }

  return true;
};

/**
 * Updates funded amounts/balances using modified balance nodes
 *
 * Update owner funds using modified AccountRoot and RippleState nodes
 * Update funded amounts for offers in the orderbook using owner funds
 *
 * @param {Object} transaction - transaction that holds meta nodes
 */

OrderBook.prototype.updateFundedAmounts = function(transaction) {
  const self = this;

  if (!this._currencyGets.is_native() && !this._issuerTransferRate) {
    if (this._remote.trace) {
      log.info('waiting for transfer rate');
    }

    this.requestTransferRate(function() {
      // Defer until transfer rate is requested
      self.updateFundedAmounts(transaction);
    });
    return;
  }

  const affectedNodes = transaction.mmeta.getNodes({
    nodeType: 'ModifiedNode',
    entryType: this._currencyGets.is_native() ? 'AccountRoot' : 'RippleState'
  });

  _.each(affectedNodes, function(node) {
    if (self.isBalanceChangeNode(node)) {
      const result = self.parseAccountBalanceFromNode(node);

      if (self.hasOwnerFunds(result.account)) {
        // We are only updating owner funds that are already cached
        self.setOwnerFunds(result.account, result.balance);

        self.updateOwnerOffersFundedAmount(result.account);
      }
    }
  });
};

/**
 * Update offers' funded amount with their owner's funds
 *
 * @param {String} account - owner's account address
 */

OrderBook.prototype.updateOwnerOffersFundedAmount = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');

  const self = this;

  if (this._remote.trace) {
    const ownerFunds = this.getOwnerFunds(account);
    log.info('updating offer funds', this._key, account,
             ownerFunds ? ownerFunds.to_text() : 'undefined');
  }

  this.resetOwnerOfferTotal(account);

  _.each(this._offers, function(offer) {
    if (offer.Account !== account) {
      return;
    }

    // Save a copy of the old offer so we can show how the offer has changed
    const previousOffer = extend({}, offer);
    let previousFundedGets;

    if (_.isString(offer.taker_gets_funded)) {
      // Offer is not new, so we should consider it for offer_changed and
      // offer_funds_changed events
      previousFundedGets = OrderBookUtils.getOfferTakerGetsFunded(offer);
    }

    self.setOfferFundedAmount(offer);
    self.addOwnerOfferTotal(offer.Account, offer.TakerGets);

    const takerGetsFunded = OrderBookUtils.getOfferTakerGetsFunded(offer);
    const areFundsChanged = previousFundedGets
      && !takerGetsFunded.equals(previousFundedGets);

    if (areFundsChanged) {
      self.emit('offer_changed', previousOffer, offer);
      self.emit('offer_funds_changed',
        offer,
        previousOffer.taker_gets_funded,
        offer.taker_gets_funded
      );
    }
  });
};

/**
 * Notify orderbook of a relevant transaction
 *
 * @param {Object} transaction
 * @api private
 */

OrderBook.prototype.notify = function(transaction) {
  const self = this;

  if (!this._subscribed) {
    return;
  }

  if (this._remote.trace) {
    log.info('notifying', this._key, transaction.transaction.hash);
  }

  const affectedNodes = transaction.mmeta.getNodes({
    entryType: 'Offer',
    bookKey: this._key
  });

  if (affectedNodes.length < 1) {
    return;
  }

  let takerGetsTotal = Amount.from_json(
    '0' + ((Currency.from_json(this._currencyGets).is_native())
           ? ''
           : ('/' + this._currencyGets.to_human() + '/' + this._issuerGets))
  );

  let takerPaysTotal = Amount.from_json(
    '0' + ((Currency.from_json(this._currencyPays).is_native())
           ? ''
           : ('/' + this._currencyPays.to_human() + '/' + this._issuerPays))
  );

  const isOfferCancel =
    transaction.transaction.TransactionType === 'OfferCancel';
  const transactionOwnerFunds = transaction.transaction.owner_funds;

  function handleNode(node) {
    switch (node.nodeType) {
      case 'DeletedNode':
        self.deleteOffer(node, isOfferCancel);

        // We don't want to count an OfferCancel as a trade
        if (!isOfferCancel) {
          takerGetsTotal = takerGetsTotal.add(node.fieldsFinal.TakerGets);
          takerPaysTotal = takerPaysTotal.add(node.fieldsFinal.TakerPays);
        }
        break;

      case 'ModifiedNode':
        self.modifyOffer(node);

        takerGetsTotal = takerGetsTotal
          .add(node.fieldsPrev.TakerGets)
          .subtract(node.fieldsFinal.TakerGets);

        takerPaysTotal = takerPaysTotal
          .add(node.fieldsPrev.TakerPays)
          .subtract(node.fieldsFinal.TakerPays);
        break;

      case 'CreatedNode':
        // rippled does not set owner_funds if the order maker is the issuer
        // because the value would be infinite
        const fundedAmount = transactionOwnerFunds !== undefined ?
          transactionOwnerFunds : Infinity;
        self.setOwnerFunds(node.fields.Account, fundedAmount);
        self.insertOffer(node);
        break;
    }
  }

  _.each(affectedNodes, handleNode);

  this.emit('transaction', transaction);
  this.notifyDirectOffersChanged();
  if (!takerGetsTotal.is_zero()) {
    this.emit('trade', takerPaysTotal, takerGetsTotal);
  }
};

/**
 * Insert an offer into the orderbook
 *
 * NOTE: We *MUST* update offers' funded amounts when a new offer is placed
 *       because funds go to the highest quality offers first.
 *
 * @param {Object} node - Offer node
 */

OrderBook.prototype.insertOffer = function(node) {
  if (this._remote.trace) {
    log.info('inserting offer', this._key, node.fields);
  }

  const offer = OrderBook.offerRewrite(node.fields);
  const takerGets = this.normalizeAmount(this._currencyGets, offer.TakerGets);
  const takerPays = this.normalizeAmount(this._currencyPays, offer.TakerPays);

  offer.LedgerEntryType = node.entryType;
  offer.index = node.ledgerIndex;

  // We're safe to calculate quality for newly created offers
  offer.quality = takerPays.divide(takerGets).to_text();

  const originalLength = this._offers.length;

  for (let i = 0; i < originalLength; i++) {
    const quality = OrderBookUtils.getOfferQuality(offer, this._currencyGets);
    const existingOfferQuality = OrderBookUtils.getOfferQuality(
      this._offers[i],
      this._currencyGets
    );

    if (quality.compareTo(existingOfferQuality) <= 0) {
      this._offers.splice(i, 0, offer);

      break;
    }
  }

  if (this._offers.length === originalLength) {
    this._offers.push(offer);
  }

  this.incrementOwnerOfferCount(offer.Account);

  this.updateOwnerOffersFundedAmount(offer.Account);

  this.emit('offer_added', offer);
};

/**
 * Convert any amount into default IOU
 *
 * NOTE: This is necessary in some places because Amount.js arithmetic
 * does not deal with native and non-native amounts well.
 *
 * @param {Currency} currency
 * @param {Object} amountObj
 */

OrderBook.prototype.normalizeAmount = function(currency, amountObj) {
  const value = currency.is_native()
  ? amountObj
  : amountObj.value;

  return OrderBookUtils.normalizeAmount(value);
};

/**
 * Modify an existing offer in the orderbook
 *
 * @param {Object} node - Offer node
 */

OrderBook.prototype.modifyOffer = function(node) {
  if (this._remote.trace) {
    log.info('modifying offer', this._key, node.fields);
  }

  for (let i = 0; i < this._offers.length; i++) {
    const offer = this._offers[i];

    if (offer.index === node.ledgerIndex) {
      // TODO: This assumes no fields are deleted, which is
      // probably a safe assumption, but should be checked.
      extend(offer, node.fieldsFinal);

      break;
    }
  }

  this.updateOwnerOffersFundedAmount(node.fields.Account);
};

/**
 * Delete an existing offer in the orderbook
 *
 * NOTE: We only update funded amounts when the node comes from an OfferCancel
 *       transaction because when offers are deleted, it frees up funds to fund
 *       other existing offers in the book
 *
 * @param {Object} node - Offer node
 * @param {Boolean} isOfferCancel - whether node came from an OfferCancel
 */

OrderBook.prototype.deleteOffer = function(node, isOfferCancel) {
  if (this._remote.trace) {
    log.info('deleting offer', this._key, node.fields);
  }

  for (let i = 0; i < this._offers.length; i++) {
    const offer = this._offers[i];

    if (offer.index === node.ledgerIndex) {
      // Remove offer amount from sum for account
      this.subtractOwnerOfferTotal(offer.Account, offer.TakerGets);

      this._offers.splice(i, 1);
      this.decrementOwnerOfferCount(offer.Account);

      this.emit('offer_removed', offer);

      break;
    }
  }

  if (isOfferCancel) {
    this.updateOwnerOffersFundedAmount(node.fields.Account);
  }
};

/**
 * Reset internal offers cache from book_offers request
 *
 * @param {Array} offers
 * @api private
 */

OrderBook.prototype.setOffers = function(offers) {
  assert(Array.isArray(offers), 'Offers is not an array');

  const self = this;

  this.resetCache();

  const newOffers = _.map(offers, function(rawOffer) {
    const offer = OrderBook.offerRewrite(rawOffer);

    if (offer.hasOwnProperty('owner_funds')) {
      // The first offer of each owner from book_offers contains owner balance
      // of offer's output
      self.setOwnerFunds(offer.Account, offer.owner_funds);
    }

    self.incrementOwnerOfferCount(offer.Account);

    self.setOfferFundedAmount(offer);
    self.addOwnerOfferTotal(offer.Account, offer.TakerGets);

    return offer;
  });

  this._offers = newOffers;
};

/**
 * Get offers model asynchronously
 *
 * This function takes a callback and calls it with an array containing the
 * current set of offers in this order book.
 *
 * If the data is available immediately, the callback may be called
 * synchronously
 *
 * @param {Function} callback
 */

OrderBook.prototype.offers =
OrderBook.prototype.getOffers = function(callback) {
  assert.strictEqual(typeof callback, 'function', 'Callback missing');

  if (this._synchronized) {
    callback(null, this._offers);
  } else {
    this.once('model', function(m) {
      callback(null, m);
    });
  }

  return this;
};

/**
 * Return latest known offers
 *
 * Usually, this will just be an empty array if the order book hasn't been
 * loaded yet. But this accessor may be convenient in some circumstances.
 *
 * @return {Array} offers
 */

OrderBook.prototype.offersSync =
OrderBook.prototype.getOffersSync = function() {
  return this._offers;
};

/**
 * Get request-representation of orderbook
 *
 * @return {Object} json
 */

OrderBook.prototype.toJSON =
OrderBook.prototype.to_json = function() {
  const json = {
    taker_gets: {
      currency: this._currencyGets.to_hex()
    },
    taker_pays: {
      currency: this._currencyPays.to_hex()
    }
  };

  if (!this._currencyGets.is_native()) {
    json.taker_gets.issuer = this._issuerGets;
  }

  if (!this._currencyPays.is_native()) {
    json.taker_pays.issuer = this._issuerPays;
  }

  return json;
};

/**
 * Whether the OrderBook is valid
 *
 * Note: This only checks whether the parameters (currencies and issuer) are
 *       syntactically valid. It does not check anything against the ledger.
 *
 * @return {Boolean} is valid
 */

OrderBook.prototype.isValid =
OrderBook.prototype.is_valid = function() {
  // XXX Should check for same currency (non-native) && same issuer
  return (
    this._currencyPays && this._currencyPays.is_valid() &&
    (this._currencyPays.is_native() || UInt160.is_valid(this._issuerPays)) &&
    this._currencyGets && this._currencyGets.is_valid() &&
    (this._currencyGets.is_native() || UInt160.is_valid(this._issuerGets)) &&
    !(this._currencyPays.is_native() && this._currencyGets.is_native())
  );
};

/**
 * Compute autobridged offers for an IOU:IOU orderbook by merging offers from
 * IOU:XRP and XRP:IOU books
 */

OrderBook.prototype.computeAutobridgedOffers = function() {
  assert(!this._currencyGets.is_native() && !this._currencyPays.is_native(),
    'Autobridging is only for IOU:IOU orderbooks');

  const autobridgeCalculator = new AutobridgeCalculator(
    this._currencyGets,
    this._currencyPays,
    this._legOneBook.getOffersSync(),
    this._legTwoBook.getOffersSync(),
    this._issuerGets,
    this._issuerPays
  );

  this._offersAutobridged = autobridgeCalculator.calculate();
};

/**
 * Merge direct and autobridged offers into a combined orderbook
 *
 * @return [Array]
 */

OrderBook.prototype.mergeDirectAndAutobridgedBooks = function() {
  const self = this;

  if (_.isEmpty(this._offers) && _.isEmpty(this._offersAutobridged)) {
    // still emit empty offers list to indicate that load is completed
    this.emit('model', []);
    return;
  }

  this._mergedOffers = this._offers
    .concat(this._offersAutobridged)
    .sort(function(a, b) {
      const aQuality = OrderBookUtils.getOfferQuality(a, self._currencyGets);
      const bQuality = OrderBookUtils.getOfferQuality(b, self._currencyGets);

      return aQuality.compareTo(bQuality);
    });

  this.emit('model', this._mergedOffers);
};

exports.OrderBook = OrderBook;
