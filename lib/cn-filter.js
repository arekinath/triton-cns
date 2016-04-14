/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = CNFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var LRUCache = require('lru-cache');
var restify = require('restify-clients');
var qs = require('querystring');

var consts = require('./consts');

function CNFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'CNFilter'});

	assert.object(opts.config, 'options.config');
	assert.object(opts.config.cnapi_opts, 'config.cnapi_opts');
	this.config = opts.config.cnapi_opts;
	assert.string(this.config.address, 'cnapi_opts.address');
	assert.object(opts.pollerStream, 'options.pollerStream');
	this.pollerStream = opts.pollerStream;

	assert.optionalObject(opts.agent, 'options.agent');

	this.client = restify.createJsonClient({
		url: 'http://' + this.config.address,
		agent: opts.agent
	});

	this.cache = LRUCache({
		max: 32*1024*1024,
		length: function (t) { return (JSON.stringify(t).length); },
		maxAge: 10 * 60 * 1000
	});

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};

	var self = this;
	this.timer = setInterval(function () {
		self.cacheCheck();
	}, 30000);

	stream.Transform.call(this, xformOpts);
}
util.inherits(CNFilter, stream.Transform);

CNFilter.prototype.cacheCheck = function () {
	var self = this;
	this.cache.forEach(function (obj, uuid) {
		self.client.get('/servers/' + uuid,
		    function (err, req, res, newObj) {
			if (err)
				return;
			newObj = cutServerObj(newObj);

			if (newObj.down !== obj.down) {
				self.log.info({
					uuid: uuid,
					new: newObj,
					old: obj
				}, 'noticed CN status change, polling');
				self.cache.del(uuid);
				self.pollerStream.start({
					server_uuid: uuid,
					state: 'active'
				});
			}
		});
	});
};

CNFilter.prototype._transform = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	if (typeof (vm.server_uuid) !== 'string') {
		vm.server = {};
		this.push(vm);
		cb();
		return;
	}
	assert.string(vm.server_uuid, 'vm.server_uuid');

	var self = this;
	this.getServer(vm.server_uuid, function (err, server) {
		if (err) {
			self.log.warn({
			    vm: vm.uuid,
			    user: vm.server_uuid,
			    err: err
			}, 'got error retrieving CN record, dropping');
			cb();
			return;
		}

		vm.server = server;
		self.push(vm);
		cb();
	});
};

CNFilter.prototype.getServer = function (uuid, cb) {
	var v = this.cache.get(uuid);
	if (v) {
		cb(null, v);
		return;
	}

	var self = this;
	this.client.get('/servers/' + uuid, function (err, req, res, obj) {
		if (err) {
			cb(err);
			return;
		}
		var cutObj = cutServerObj(obj);
		self.cache.set(uuid, cutObj);
		cb(null, cutObj);
	});
};

function cutServerObj(obj) {
	var cutObj = {};
	cutObj.uuid = obj.uuid;
	cutObj.status = obj.status;
	cutObj.last_heartbeat = new Date(obj.last_heartbeat);
	cutObj.heartbeat_age = (new Date()) - cutObj.last_heartbeat;
	cutObj.last_boot = new Date(obj.last_boot);
	cutObj.last_boot_age = (new Date()) - cutObj.last_boot;

	/*
	 * "CN that is not running" includes CNs with a non-"running" status
	 * and a last_heartbeat >2min ago, those that have not heartbeated in
	 * the last 5 min, and CNs that have only booted up in the last
	 * 2 min.
	 *
	 * This policy is here because it is shared between the cache update
	 * logic here and the logic in flag-filter.js
	 */
	cutObj.down = ((cutObj.status !== 'running' &&
	    cutObj.heartbeat_age > 120000) ||
	    cutObj.heartbeat_age > 300000 ||
	    cutObj.last_boot_age < 120000);
	return (cutObj);
}

CNFilter.cutServerObj = cutServerObj;
