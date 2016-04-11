var Steam = require('steam-client');
var SteamUser = require('../index.js');
var ByteBuffer = require('bytebuffer');
var SteamID = require('steamid');
var Helpers = require('./helpers.js');
var SteamCrypto = require('@doctormckay/steam-crypto');

/**
 * Parse a Steam app or session ticket and return an object containing its details. Static.
 * @param {Buffer|ByteBuffer} ticket - The binary appticket
 * @returns {object|null} - object if well-formed ticket (may not be valid), or null if not well-formed
 */
SteamUser.parseAppTicket = function(ticket) {
	if (!ByteBuffer.isByteBuffer(ticket)) {
		ticket = ByteBuffer.wrap(ticket, ByteBuffer.LITTLE_ENDIAN);
	}

	var details = {};

	try {
		// TODO: Leading SteamID, GCTOKEN, and SESSIONHEADER

		var ticketLength = ticket.readUint32();
		if (ticket.offset - 4 + ticketLength != ticket.limit && ticket.offset - 4 + ticketLength + 128 != ticket.limit) {
			console.log("Bad length: " + ticketLength + " vs " + ticket.limit);
			return null;
		}

		var i, j, dlc;

		details.version = ticket.readUint32();
		details.steamID = new SteamID(ticket.readUint64().toString());
		details.appID = ticket.readUint32();
		details.externalIP = Helpers.ipIntToString(ticket.readUint32());
		details.internalIP = Helpers.ipIntToString(ticket.readUint32());
		details.ownershipFlags = ticket.readUint32();
		details.generated = new Date(ticket.readUint32() * 1000);
		details.expires = new Date(ticket.readUint32() * 1000);
		details.licenses = [];

		var licenseCount = ticket.readUint16();
		for (i = 0; i < licenseCount; i++) {
			details.licenses.push(ticket.readUint32());
		}

		details.dlc = [];

		var dlcCount = ticket.readUint16();
		for (i = 0; i < dlcCount; i++) {
			dlc = {};
			dlc.appID = ticket.readUint32();
			dlc.licenses = [];

			licenseCount = ticket.readUint16();

			for (j = 0; j < licenseCount; j++) {
				dlc.licenses.push(readUint32());
			}

			details.dlc.push(dlc);
		}

		ticket.readUint16(); // reserved
		if (ticket.offset + 128 == ticket.limit) {
			// Has signature
			details.signature = ticket.slice(ticket.offset, ticket.offset + 128).toBuffer();
		}

		var date = new Date();
		details.expired = details.expires < date;
		details.validSignature = details.signature && SteamCrypto.verifySignature(ticket.slice(0, ticketLength).toBuffer(), details.signature);
		details.isValid = !details.expired && (!details.signature || details.validSignature);
	} catch (ex) {
		console.log(ex);
		return null; // not a valid ticket
	}

	return details;
};

SteamUser.prototype.getAuthSessionTicket = function(appid, callback) {
	// For an auth session ticket we need the following:
	// 1. 64-bit SteamID
	// 2. Length-prefixed GCTOKEN
	// 3. Length-prefixed SESSIONHEADER
	// 4. Length-prefixed OWNERSHIPTICKET (yes, even though the ticket itself has a length)
	// The GCTOKEN and SESSIONHEADER portion is passed to ClientAuthList for reuse validation
	var self = this;
	this.getAppOwnershipTicket(appid, function(err, ticket) {
		if (err) {
			callback(err);
			return;
		}

		// Do we have any GC tokens?
		if (self._gcTokens.length > 0) {
			buildToken();
		} else {
			self.once('_gcTokens', buildToken); // continue once we get some tokens
		}

		function buildToken() {
			var gcToken = self._gcTokens.splice(0, 1)[0];
			var buffer = new ByteBuffer(8 + 4 + gcToken.length + 4 + 24 + 4 + ticket.length, ByteBuffer.LITTLE_ENDIAN);
			buffer.writeUint64(self.steamID.getSteamID64());
			buffer.writeUint32(gcToken.length);
			buffer.append(gcToken);
			buffer.writeUint32(24); // length of the session header, which is always 24 bytes
			buffer.writeUint32(1); // unknown 1
			buffer.writeUint32(2); // unknown 2
			buffer.writeUint32(Helpers.ipStringToInt(self.publicIP)); // external IP
			buffer.writeUint32(0); // filler
			buffer.writeUint32(Date.now() - self._connectTime); // timestamp
			buffer.writeUint32(++self._connectionCount); // connection count
			buffer.writeUint32(ticket.length);
			buffer.append(ticket);
			callback(null, buffer.flip().toBuffer());
		}
	});
};

SteamUser.prototype.getAppOwnershipTicket = function(appid, callback) {
	var self = this;

	// See if we have one saved
	this.storage.readFile("appOwnershipTicket_" + this.steamID + "_" + appid + ".bin", function(err, file) {
		if (!err && file) {
			var parsed = SteamUser.parseAppTicket(file);
			// Only return the saved ticket if it has a valid signature, expires more than 6 hours from now, and has the same external IP as we have right now.
			if (parsed && parsed.isValid && parsed.expires - Date.now() >= (1000 * 60 * 60 * 6) && parsed.externalIP == self.publicIP) {
				callback(null, file);
				return;
			}
		}

		self._send(Steam.EMsg.ClientGetAppOwnershipTicket, {"app_id": appid}, function(body) {
			if (body.eresult != Steam.EResult.OK) {
				callback(Helpers.eresultError(body.eresult));
				return;
			}

			if (body.app_id != appid) {
				callback(new Error("Cannot get app ownership ticket"));
				return;
			}

			var ticket = body.ticket.toBuffer();
			if (ticket && ticket.length > 10 && self.options.saveAppTickets) {
				self.storage.saveFile("appOwnershipTicket_" + self.steamID + "_" + appid + ".bin", ticket);
			}

			callback(null, body.ticket.toBuffer());
		});
	});
};

// Handlers

SteamUser.prototype._handlers[Steam.EMsg.ClientGameConnectTokens] = function(body) {
	var self = this;

	this.emit('debug', "Received " + body.tokens.length + " game connect tokens");
	body.tokens.forEach(function(token) {
		self._gcTokens.push(token.toBuffer());
	});

	this.emit('_gcTokens'); // internal private event
};