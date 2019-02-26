'use strict';

var path = require('path');

var config = exports;

config.caCertFileName = 'cnproxy.ca.crt';

config.caKeyFileName = 'cnproxy.ca.key.pem';

config.defaultPort = 6789;

config.caName = 'CNPROXY CA';

config.getDefaultCABasePath = function () {
    var userHome = process.env.HOME || process.env.USERPROFILE;
    return path.resolve(userHome, './.cnproxy');
};

config.getDefaultCACertPath = function () {
    return path.resolve(config.getDefaultCABasePath(), config.caCertFileName);
};

config.getDefaultCACertPath = function () {
    return path.resolve(config.getDefaultCABasePath(), config.caKeyFileName);
};