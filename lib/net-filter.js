/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 */

module.exports = NetFilter;

var stream = require('stream');
var util = require('util');
var assert = require('assert-plus');
var utils = require('./utils');
var bunyan = require('bunyan');
var vasync = require('vasync');
var LRUCache = require('lru-cache');

var consts = require('./consts');

function NetFilter(opts) {
	assert.object(opts, 'options');

	assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || bunyan.createLogger({name: 'cns'});
	this.log = log.child({stage: 'NetFilter'});
	assert.object(opts.config, 'options.config');
	this.config = opts.config.forward_zones;

	var xformOpts = {
		readableObjectMode: true,
		writableObjectMode: true
	};
	stream.Transform.call(this, xformOpts);
}
util.inherits(NetFilter, stream.Transform);

NetFilter.prototype._transform = function (vm, enc, cb) {
	assert.object(vm, 'vm');
	assert.arrayOfObject(vm.nics, 'vm.nics');

	var self = this;
	var zones = Object.keys(this.config);
	vm.nics.forEach(function (nic) {
		nic.zones = [];
		for (var i = 0; i < zones.length; ++i) {
			var z = self.config[zones[i]];
			if (z.networks.indexOf(nic.network_uuid) !== -1)
				nic.zones.push(zones[i]);
		}
		for (i = 0; i < zones.length; ++i) {
			z = self.config[zones[i]];
			if (z.networks.indexOf('*') !== -1 &&
			    nic.zones.length === 0)
				nic.zones.push(zones[i]);
		}
	});

	this.push(vm);
	cb();
};
