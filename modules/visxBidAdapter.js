import * as utils from '../src/utils.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import { config } from '../src/config.js';
const BIDDER_CODE = 'visx';
const BASE_URL = 'https://t.visx.net';
const ENDPOINT_URL = BASE_URL + '/hb';
const TIME_TO_LIVE = 360;
const DEFAULT_CUR = 'EUR';
const ADAPTER_SYNC_URL = BASE_URL + '/push_sync';
const TRACK_WIN_URL = BASE_URL + '/track/win';
const TRACK_PENDING_URL = BASE_URL + '/track/pending';
const TRACK_TIMEOUT_URL = BASE_URL + '/track/bid_timeout';
const LOG_ERROR_MESS = {
  noAuid: 'Bid from response has no auid parameter - ',
  noAdm: 'Bid from response has no adm parameter - ',
  noBid: 'Array of bid objects is empty',
  noPlacementCode: 'Can\'t find in requested bids the bid with auid - ',
  emptyUids: 'Uids should not be empty',
  emptySeatbid: 'Seatbid array from response has an empty item',
  emptyResponse: 'Response is empty',
  hasEmptySeatbidArray: 'Response has empty seatbid array',
  hasNoArrayOfBids: 'Seatbid from response has no array of bid objects - ',
  notAllowedCurrency: 'Currency is not supported - ',
  currencyMismatch: 'Currency from the request is not match currency from the response - '
};
const currencyWhiteList = ['EUR', 'USD', 'GBP', 'PLN'];
export const spec = {
  code: BIDDER_CODE,
  isBidRequestValid: function(bid) {
    return !!bid.params.uid;
  },
  buildRequests: function(validBidRequests, bidderRequest) {
    const auids = [];
    const bidsMap = {};
    const slotsMapByUid = {};
    const sizeMap = {};
    const bids = validBidRequests || [];
    const currency =
      config.getConfig(`currency.bidderCurrencyDefault.${BIDDER_CODE}`) ||
      config.getConfig('currency.adServerCurrency') ||
      DEFAULT_CUR;
    let reqId;
    let payloadSchain;
    let payloadUserId;

    if (currencyWhiteList.indexOf(currency) === -1) {
      utils.logError(LOG_ERROR_MESS.notAllowedCurrency + currency);
      return;
    }

    bids.forEach(bid => {
      reqId = bid.bidderRequestId;
      const {params: {uid}, adUnitCode, schain, userId} = bid;
      auids.push(uid);
      if (!payloadSchain && schain) {
        payloadSchain = schain;
      }
      if (!payloadUserId && userId) {
        payloadUserId = userId;
      }
      const sizesId = utils.parseSizesInput(bid.sizes);

      if (!slotsMapByUid[uid]) {
        slotsMapByUid[uid] = {};
      }
      const slotsMap = slotsMapByUid[uid];
      if (!slotsMap[adUnitCode]) {
        slotsMap[adUnitCode] = {adUnitCode, bids: [bid], parents: []};
      } else {
        slotsMap[adUnitCode].bids.push(bid);
      }
      const slot = slotsMap[adUnitCode];

      sizesId.forEach((sizeId) => {
        sizeMap[sizeId] = true;
        if (!bidsMap[uid]) {
          bidsMap[uid] = {};
        }

        if (!bidsMap[uid][sizeId]) {
          bidsMap[uid][sizeId] = [slot];
        } else {
          bidsMap[uid][sizeId].push(slot);
        }
        slot.parents.push({parent: bidsMap[uid], key: sizeId, uid});
      });
    });

    const payload = {
      pt: 'net',
      auids: auids.join(','),
      sizes: utils.getKeys(sizeMap).join(','),
      r: reqId,
      cur: currency,
      wrapperType: 'Prebid_js',
      wrapperVersion: '$prebid.version$'
    };

    if (payloadSchain) {
      payload.schain = JSON.stringify(payloadSchain);
    }

    if (payloadUserId) {
      if (payloadUserId.tdid) {
        payload.tdid = payloadUserId.tdid;
      }
      if (payloadUserId.id5id && payloadUserId.id5id.uid) {
        payload.id5 = payloadUserId.id5id.uid;
      }
      if (payloadUserId.digitrustid && payloadUserId.digitrustid.data && payloadUserId.digitrustid.data.id) {
        payload.dtid = payloadUserId.digitrustid.data.id;
      }
    }

    if (bidderRequest) {
      if (bidderRequest.refererInfo && bidderRequest.refererInfo.referer) {
        payload.u = bidderRequest.refererInfo.referer;
      }
      if (bidderRequest.gdprConsent) {
        if (bidderRequest.gdprConsent.consentString) {
          payload.gdpr_consent = bidderRequest.gdprConsent.consentString;
        }
        payload.gdpr_applies =
            (typeof bidderRequest.gdprConsent.gdprApplies === 'boolean')
              ? Number(bidderRequest.gdprConsent.gdprApplies) : 1;
      }
    }

    return {
      method: 'GET',
      url: ENDPOINT_URL,
      data: payload,
      bidsMap: bidsMap,
    };
  },
  interpretResponse: function(serverResponse, bidRequest) {
    serverResponse = serverResponse && serverResponse.body;
    const bidResponses = [];
    const bidsWithoutSizeMatching = [];
    const bidsMap = bidRequest.bidsMap;
    const currency = bidRequest.data.cur;

    let errorMessage;

    if (!serverResponse) errorMessage = LOG_ERROR_MESS.emptyResponse;
    else if (serverResponse.seatbid && !serverResponse.seatbid.length) {
      errorMessage = LOG_ERROR_MESS.hasEmptySeatbidArray;
    }

    if (!errorMessage && serverResponse.seatbid) {
      serverResponse.seatbid.forEach(respItem => {
        _addBidResponse(_getBidFromResponse(respItem), bidsMap, currency, bidResponses, bidsWithoutSizeMatching);
      });
      bidsWithoutSizeMatching.forEach(serverBid => {
        _addBidResponse(serverBid, bidsMap, currency, bidResponses);
      });
    }
    if (errorMessage) utils.logError(errorMessage);
    return bidResponses;
  },
  getUserSyncs: function(syncOptions, serverResponses, gdprConsent) {
    if (syncOptions.pixelEnabled) {
      var query = [];
      if (gdprConsent) {
        if (gdprConsent.consentString) {
          query.push('gdpr_consent=' + encodeURIComponent(gdprConsent.consentString));
        }
        query.push('gdpr_applies=' + encodeURIComponent(
          (typeof gdprConsent.gdprApplies === 'boolean')
            ? Number(gdprConsent.gdprApplies) : 1));
      }
      return [{
        type: 'image',
        url: ADAPTER_SYNC_URL + (query.length ? '?' + query.join('&') : '')
      }];
    }
  },
  onSetTargeting: function(bid) {
    // Call '/track/pending' with the corresponding bid.requestId
    utils.triggerPixel(TRACK_PENDING_URL + '?requestId=' + bid.requestId);
  },
  onBidWon: function(bid) {
    // Call '/track/win' with the corresponding bid.requestId
    utils.triggerPixel(TRACK_WIN_URL + '?requestId=' + bid.requestId);
  },
  onTimeout: function(timeoutData) {
    // Call '/track/bid_timeout' with timeout data
    utils.triggerPixel(TRACK_TIMEOUT_URL + '?data=' + JSON.stringify(timeoutData));
  }
};

function _getBidFromResponse(respItem) {
  if (!respItem) {
    utils.logError(LOG_ERROR_MESS.emptySeatbid);
  } else if (!respItem.bid) {
    utils.logError(LOG_ERROR_MESS.hasNoArrayOfBids + JSON.stringify(respItem));
  } else if (!respItem.bid[0]) {
    utils.logError(LOG_ERROR_MESS.noBid);
  }
  return respItem && respItem.bid && respItem.bid[0];
}

function _addBidResponse(serverBid, bidsMap, currency, bidResponses, bidsWithoutSizeMatching) {
  if (!serverBid) return;
  let errorMessage;
  if (!serverBid.auid) errorMessage = LOG_ERROR_MESS.noAuid + JSON.stringify(serverBid);
  if (!serverBid.adm) errorMessage = LOG_ERROR_MESS.noAdm + JSON.stringify(serverBid);
  else {
    const reqCurrency = currency || DEFAULT_CUR;
    const awaitingBids = bidsMap[serverBid.auid];
    if (awaitingBids) {
      if (serverBid.cur && serverBid.cur !== reqCurrency) {
        errorMessage = LOG_ERROR_MESS.currencyMismatch + reqCurrency + ' - ' + serverBid.cur;
      } else {
        const sizeId = bidsWithoutSizeMatching ? `${serverBid.w}x${serverBid.h}` : Object.keys(awaitingBids)[0];
        if (awaitingBids[sizeId]) {
          const slot = awaitingBids[sizeId][0];

          const bid = slot.bids.shift();
          bidResponses.push({
            requestId: bid.bidId,
            cpm: serverBid.price,
            width: serverBid.w,
            height: serverBid.h,
            creativeId: serverBid.auid,
            currency: reqCurrency,
            netRevenue: true,
            ttl: TIME_TO_LIVE,
            ad: serverBid.adm,
            dealId: serverBid.dealid
          });

          if (!slot.bids.length) {
            slot.parents.forEach(({parent, key, uid}) => {
              const index = parent[key].indexOf(slot);
              if (index > -1) {
                parent[key].splice(index, 1);
              }
              if (!parent[key].length) {
                delete parent[key];
                if (!utils.getKeys(parent).length) {
                  delete bidsMap[uid];
                }
              }
            });
          }
        } else {
          bidsWithoutSizeMatching && bidsWithoutSizeMatching.push(serverBid);
        }
      }
    } else {
      errorMessage = LOG_ERROR_MESS.noPlacementCode + serverBid.auid;
    }
  }
  if (errorMessage) {
    utils.logError(errorMessage);
  }
}

registerBidder(spec);
