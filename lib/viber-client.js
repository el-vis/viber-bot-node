"use strict";

const _ = require('underscore');
const needle = require('needle');
const util = require('util');
const pjson = require(__dirname + '/../package.json');

const SUCCESSFUL_REQUEST_STATUS = 0;
const VIBER_AUTH_TOKEN_HEADER = "X-Viber-Auth-Token";
const MAX_GET_ONLINE_IDS = 100;
const API_ENDPOINTS = {
	"setWebhook": "/set_webhook",
	"getAccountInfo": "/get_account_info",
	"getUserDetails": "/get_user_details",
	"getOnlineStatus": "/get_online",
	"sendMessage": "/send_message",
	"broadcastMessage": "/broadcast_message",
	"post": "/post"
};

function ViberClient(logger, bot, apiUrl, subscribedEvents) {
	this._logger = logger;
	this._bot = bot;
	this._url = apiUrl;
	this._subscribedEvents = subscribedEvents;
	this._userAgent = util.format("ViberBot-Node/%s", pjson.version);
}

ViberClient.prototype.setWebhook = function (url, isInline) {
	this._logger.info("Sending 'setWebhook' request for url: %s, isInline: %s", url, isInline);
	return this._sendRequest("setWebhook", {
		"url": url,
		"is_inline": isInline,
		"event_types": this._subscribedEvents
	});
};

ViberClient.prototype.sendMessage = function (optionalReceiver, messageType, messageData, optionalTrackingData, optionalKeyboard, optionalChatId, optionalMinApiVersion) {
	if (!optionalReceiver && !optionalChatId) {
		return Promise.reject(new Error(`Invalid arguments passed to sendMessage. 'optionalReceiver' and 'chatId' are Missing.`));
	}

	if (messageType && !messageData) {
		return Promise.reject(new Error(`Invalid arguments passed to sendMessage. 'MessageData' is Missing.`));
	}

	if (!messageType && !messageData && !optionalKeyboard) {
		return Promise.reject(new Error(`Invalid arguments passed to sendMessage. 'MessageData','messageType' are Missing and there's no keyboard.`));
	}

	const request = {
		"sender": {
			"name": this._bot.name,
			"avatar": this._bot.avatar
		},
		"tracking_data": this._serializeTrackingData(optionalTrackingData),
		"keyboard": optionalKeyboard,
		"chat_id": optionalChatId,
		"min_api_version": optionalMinApiVersion
	};

	if (optionalReceiver) {
		request["receiver"] = optionalReceiver;
	}

	this._logger.debug("Sending %s message to viber user '%s' with data", messageType, optionalReceiver, messageData);
	return this._sendRequest("sendMessage", Object.assign(request, messageData));
};

/**
 * Maximum total JSON size of the request is 30kb. The maximum list length is 300 receivers.
 * The Broadcast API is used to send messages to multiple recipients with a rate limit of 500 requests in a 10 seconds window.
 * @param receivers
 * @param messageType
 * @param messageData
 * @param optionalTrackingData
 * @param optionalKeyboard
 * @param optionalMinApiVersion
 * @returns {Promise<never>|Promise<unknown>}
 */
ViberClient.prototype.broadcastMessage = function (receivers, messageType, messageData, optionalTrackingData, optionalKeyboard, optionalMinApiVersion) {
	if (!receivers) {
		return Promise.reject(new Error(`Invalid arguments passed to broadcastMessage. 'receivers' are Missing.`));
	}

	if (receivers.length > 300) {
		return Promise.reject(new Error(`Invalid arguments passed to broadcastMessage. Max size of 'receivers' list = 300. Now 'receivers' = ${receivers.length}`));
	}


	if (messageType && !messageData) {
		return Promise.reject(new Error(`Invalid arguments passed to broadcastMessage. 'MessageData' is Missing.`));
	}

	if (!messageType && !messageData && !optionalKeyboard) {
		return Promise.reject(new Error(`Invalid arguments passed to broadcastMessage. 'MessageData','messageType' are Missing and there's no keyboard.`));
	}

	const request = {
		"sender": {
			"name": this._bot.name,
			"avatar": this._bot.avatar
		},
		"tracking_data": this._serializeTrackingData(optionalTrackingData),
		"keyboard": optionalKeyboard,
		"broadcast_list": receivers,
		"min_api_version": optionalMinApiVersion
	};


	this._logger.debug("Sending %s message to viber user '%s' with data", messageType, receivers, messageData);
	return this._sendRequest("broadcastMessage", Object.assign(request, messageData));
};

ViberClient.prototype.getAccountInfo = function () {
	return this._sendRequest("getAccountInfo", {});
};

ViberClient.prototype.getUserDetails = function (viberUserId) {
	if (!viberUserId) throw new Error(`Missing user id`);
	return this._sendRequest("getUserDetails", { "id": viberUserId });
};

ViberClient.prototype.getOnlineStatus = function (viberUserIds) {
	viberUserIds = _.isArray(viberUserIds) ? viberUserIds : [viberUserIds];

	if (_.isEmpty(viberUserIds)) throw new Error(`Empty or no user ids passed to getOnlineStatus`);
	if (_.size(viberUserIds) > MAX_GET_ONLINE_IDS) {
		throw new Error(`Can only check up to ${MAX_GET_ONLINE_IDS} ids per request`);
	}

	return this._sendRequest("getOnlineStatus", { "ids": viberUserIds });
};

ViberClient.prototype.postToPublicChat = function (senderProfile, messageType, messageData, optionalMinApiVersion) {
	if (!senderProfile) {
		return Promise.reject(new Error(`Invalid arguments passed to postToPublicChat. 'senderProfile' is Missing.`));
	}

	if (!messageType || !messageData) {
		return Promise.reject(new Error(`Invalid arguments passed to postToPublicChat. 'MessageData' or 'messageType' are Missing.`));
	}

	const request = {
		"from": senderProfile.id,
		"sender": {
			"name": senderProfile.name,
			"avatar": senderProfile.avatar
		},
		"min_api_version": optionalMinApiVersion
	};

	this._logger.debug("Sending %s message to public chat as viber user '%s' with data", messageType, senderProfile.id, messageData);
	return this._sendRequest("post", Object.assign(request, messageData));
};

ViberClient.prototype._sendRequest = function (endpoint, data) {
	if (!_.has(API_ENDPOINTS, endpoint)) {
		return Promise.reject(new Error(`could not find endpoint ${endpoint}`));
	}

	const self = this;
	const url = util.format("%s%s", this._url, API_ENDPOINTS[endpoint]);
	const dataWithAuthToken = Object.assign({ "auth_token": this._bot.authToken }, data);
	const options = {
		json: true, rejectUnauthorized: true, parse: true,
		user_agent: this._userAgent, // eslint-disable-line
		headers: {
			[VIBER_AUTH_TOKEN_HEADER]: this._bot.authToken
		}
	};

	this._logger.debug("Opening request to url: '%s' with data", url, data);
	return new Promise((resolve, reject) => {
		try {
			needle.post(url, dataWithAuthToken, options)
				.on("data", data => self._readData(data, resolve, reject))
				.on("end", err => self._requestEnded(err, reject))
				.on("err", err => reject(err));
		}
		catch (err) {
			reject(err);
		}
	});
};

ViberClient.prototype._readData = function (data, resolve, reject) {
	if (data.status != SUCCESSFUL_REQUEST_STATUS) {
		this._logger.error("Response error", data);
		return reject(data);
	}
	this._logger.debug("Response data", data);
	return resolve(data);
};

ViberClient.prototype._requestEnded = function (err, reject) {
	if (err) {
		this._logger.error("Request ended with an error", err);
		return reject(err);
	}
	this._logger.debug("Request ended successfully");
};

ViberClient.prototype._serializeTrackingData = function (optionalTrackingData) {
	if (optionalTrackingData == null || _.isEmpty(optionalTrackingData)) {
		// because of bug in production, we cannot send null, but we can send an empty string
		optionalTrackingData = "";
	}
	return JSON.stringify(optionalTrackingData);
};

module.exports = ViberClient;
