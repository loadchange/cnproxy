'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var fs = require('fs');
var os = require('os');
var url = require('url');
var http = require('http');
var path = require('path');
var Step = require('step');
var https = require('https');
var constants = require('constants');
var Buffer = require('buffer').Buffer;
var tunnelAgent = require('tunnel-agent');

var log = require('./log');
var Agent = require('./ProxyHttpAgent');
var HttpsAgent = require('./ProxyHttpsAgent');

var httpsAgent = new HttpsAgent({
    keepAlive: true,
    timeout: 60000,
    keepAliveTimeout: 30000, // free socket keepalive for 30 seconds
    rejectUnauthorized: false
});
var httpAgent = new Agent({
    keepAlive: true,
    timeout: 60000,
    keepAliveTimeout: 30000 // free socket keepalive for 30 seconds
});
var socketId = 0;

var httpOverHttpAgent = void 0,
    httpsOverHttpAgent = void 0,
    httpOverHttpsAgent = void 0,
    httpsOverHttpsAgent = void 0;

var REQ_TIMEOUT = 10 * 1000;
var RES_TIMEOUT = 10 * 1000;

http.globalAgent.maxSockets = 25;
https.globalAgent.maxSockets = 25;

/**
 * Load file without cache
 *
 * @return {Array} load list from a file
 */
function _loadFile(filename) {
    var module = require(filename);
    delete require.cache[require.resolve(filename)];
    return module;
}

var utils = {
    loadConfiguration: function loadConfiguration(filePath) {
        if (typeof filePath !== 'string') {
            return null;
        }
        if (!fs.existsSync(filePath)) {
            throw new Error('File doesn\'t exist!');
        }
        if (!utils.isAbsolutePath(filePath)) {
            filePath = path.join(process.cwd(), filePath);
        }
        return _loadFile(filePath);
    },
    watchConfiguration: function watchConfiguration(filePath, callback) {
        fs.watchFile(filePath, function (curr, prev) {
            log.warn('The rule file has been modified!');
            callback();
        });
    },

    /**
     * Process url with valid format especially in https cases
     * in which, req.url doesn't include protocol and host
     *
     * @param {Object} req
     */
    processUrl: function processUrl(req, rOptions) {
        var hostArr = req.headers.host.split(':');
        var hostname = hostArr[0];
        var port = hostArr[1];

        var parsedUrl = url.parse(req.url, true);
        parsedUrl.protocol = parsedUrl.protocol || (req.type ? req.type + ':' : null) || rOptions.protocol;
        parsedUrl.hostname = parsedUrl.hostname || hostname;

        if (!parsedUrl.port && port) {
            parsedUrl.port = port;
        }

        return url.format(parsedUrl);
    },
    processUrlWithQSAbandoned: function processUrlWithQSAbandoned(urlStr) {
        return urlStr.replace(/\?.*$/, '');
    },


    /**
     * Simple wrapper for the default http.request
     *
     * @param {Object} options options about url, method and headers
     * @param {Function} callback callback to handle the response object
     */
    request: function request(options, callback) {
        var parsedUrl = void 0;
        var requestUrl = void 0;
        var requestMethod = void 0;
        var requestHeaders = void 0;
        var requestHandler = void 0;
        var requestOptions = void 0;
        var request = void 0;
        var sender = void 0;
        var requestTimeout = void 0;
        var responseTimeout = void 0;
        var buffers = void 0;

        if (typeof callback !== 'function') {
            log.error('No callback specified!');
            return;
        }

        requestHandler = callback;

        if ((typeof options === 'undefined' ? 'undefined' : _typeof(options)) !== 'object') {
            requestHandler(new Error('No options specified!'));
            return;
        }

        requestUrl = options.url;

        if (typeof requestUrl === 'undefined') {
            requestHandler(new Error('No url specified!'));
            return;
        }

        try {
            requestUrl = url.parse(requestUrl);
        } catch (e) {
            requestHandler(new Error('Invalid url'));
            return;
        }

        requestMethod = options.method || 'GET';
        requestHeaders = options.headers;

        requestOptions = {
            hostname: requestUrl.hostname || 'localhost',
            port: requestUrl.port || (requestUrl.protocol === 'https:' ? 443 : 80),
            method: requestMethod,
            path: requestUrl.path,
            rejectUnauthorized: false,
            secureOptions: constants.SSL_OP_NO_TLSv1_2 // degrade the SSL version as v0.8.x used
        };

        if ((typeof requestHeaders === 'undefined' ? 'undefined' : _typeof(requestHeaders)) === 'object') {
            requestOptions.headers = requestHeaders;
        }

        sender = requestUrl.protocol === 'https:' ? https : http;

        requestTimeout = setTimeout(function () {
            log.error('Request timeout for ' + options.url);
            requestTimeout = null;
            request.abort();
            requestHandler(new Error('Request Timtout'));
        }, utils.reqTimeout);

        log.debug('Send ' + requestMethod + ' for ' + options.url + ' at ' + new Date());
        request = sender.request(requestOptions, function (res) {
            log.debug('Finish ' + requestMethod + ' the request for ' + options.url + ' at ' + new Date());

            clearTimeout(requestTimeout);
            responseTimeout = setTimeout(function () {
                log.error('Response timeout for ' + requestMethod + ' ' + options.url);
                responseTimeout = null;
                request.abort();
                requestHandler(new Error('Response timeout'));
            }, utils.resTimeout);

            buffers = [];
            res.on('data', function (chunk) {
                buffers.push(chunk);
            });

            res.on('end', function () {
                log.debug('Get the response of ' + requestMethod + ' ' + options.url + ' at ' + new Date());
                if (responseTimeout) {
                    clearTimeout(responseTimeout);
                }
                requestHandler(null, Buffer.concat(buffers), res);
            });
        });

        if (utils.isContainBodyData(requestMethod)) {
            request.write(options.data);
        }

        request.on('error', function (err) {
            log.error('url: ' + options.url);
            log.error('msg: ' + err.message);

            if (requestTimeout) {
                clearTimeout(requestTimeout);
            }

            requestHandler(err);
        });

        request.end();
    },


    /**
     * Concat files in the file list into one single file
     *
     * @param {Array} fileList
     * @param {String} dest the path of dest file
     *
     */
    concat: function concat(fileList, cb) {
        var group = void 0;
        var buffers = [];
        if (!Array.isArray(fileList)) {
            log.error('fileList is not a Array!');
            return;
        }

        log.info('Start combine ' + fileList.length + ' files');

        Step(function readFiles() {
            group = this.group();

            fileList.forEach(function (file) {
                fs.readFile(file, group());
            });
        },

        /**
         * Receive all the file contents
         *
         * @param {Object} err
         * @param {Array} files Buffer list
         */
        function concatAll(err, files) {
            if (err) {
                cb(err);
            }
            log.info('Finish combination!');
            cb(null, Buffer.concat(utils._appendEnter(files)));
        });
    },


    /**
     * This is a hack function to avoid the grammer issue when concating files
     *
     * @param {Array} files buffer array containing the file contents
     *
     * @return {Array} buffer array containing the file contents and appended enter character
     */
    _appendEnter: function _appendEnter(files) {
        var newBuffers = [];
        files.forEach(function (buffer) {
            newBuffers.push(buffer);
            newBuffers.push(new Buffer('\n'));
        });

        return newBuffers;
    },


    /**
     * Find file according to the file pattern in the specified directory
     *
     * @param {String} directory
     * @param {String} filePattern
     * @param {Function} callback
     *
     * @return {String} matched file path
     */
    findFile: function findFile(directory, filename, callback) {
        Step(function readDirectory() {
            fs.readdir(directory, this);
        }, function stat(err, files) {
            var _ref = {},
                group = _ref.group,
                file = _ref.file,
                _ref$matchedStore = _ref.matchedStore,
                matchedStore = _ref$matchedStore === undefined ? [] : _ref$matchedStore,
                stat1 = _ref.stat1,
                index = _ref.index;


            if (err) {
                callback(err);
                return;
            }

            for (var i = 0, l = files.length; i < l; i++) {
                file = files[i];

                try {
                    stat1 = fs.statSync(path.join(directory, file));
                } catch (e) {
                    log.error(e.message);
                    continue;
                }

                if (stat1.isFile()) {
                    index = path.basename(filename, path.extname(filename)).indexOf(path.basename(file, path.extname(file)));

                    if (index !== -1 && path.extname(filename) === path.extname(file)) {
                        matchedStore.push(file);
                    }
                }
            }

            return matchedStore;
        }, function match(err, matchedResults) {
            var matchedFile = void 0;

            matchedResults.forEach(function (item) {
                if (typeof matchedFile === 'undefined') {
                    matchedFile = item;
                } else {
                    matchedFile = item.length > matchedFile.length ? item : matchedFile;
                }
            });

            if (typeof matchedFile === 'undefined') {
                callback(new Error('No file matched with ' + filename));
            } else {
                callback(null, path.join(directory, matchedFile));
            }
        });
    },


    /**
     * Is the path a absolute path
     *
     * @param {String} filePath
     * @return {Boolean}
     */
    isAbsolutePath: function isAbsolutePath(filePath) {
        if (typeof filePath !== 'string') {
            return false;
        }

        if (os.platform && os.platform() === 'win32') {
            return filePath.indexOf(':') !== -1;
        } else {
            return filePath.indexOf(path.sep) === 0;
        }
    },


    /**
     * Does the HTTP request contain body data
     *
     * @param {String} HTTP method token
     *
     * @return {Boolean}
     */
    isContainBodyData: function isContainBodyData(method) {
        if (!method) {
            return false;
        }

        var white_list = ['POST', 'PUT'];
        return white_list.some(function (i) {
            return i === method;
        });
    },
    getOptionsFormRequest: function getOptionsFormRequest(req, ssl) {
        var externalProxy = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;

        var urlObject = url.parse(req.url);
        var defaultPort = ssl ? 443 : 80;
        var protocol = ssl ? 'https:' : 'http:';
        var headers = Object.assign({}, req.headers);
        var externalProxyUrl = null;

        if (externalProxy) {
            if (typeof externalProxy === 'string') {
                externalProxyUrl = externalProxy;
            } else if (typeof externalProxy === 'function') {
                try {
                    externalProxyUrl = externalProxy(req, ssl);
                } catch (e) {
                    console.error(e);
                }
            }
        }

        delete headers['proxy-connection'];
        var agent = false;
        if (!externalProxyUrl) {
            // keepAlive
            if (headers.connection !== 'close') {
                if (protocol === 'https:') {
                    agent = httpsAgent;
                } else {
                    agent = httpAgent;
                }
                headers.connection = 'keep-alive';
            }
        } else {
            agent = util.getTunnelAgent(protocol === 'https:', externalProxyUrl);
        }

        var options = {
            protocol: protocol,
            hostname: req.headers.host.split(':')[0],
            method: req.method,
            port: req.headers.host.split(':')[1] || defaultPort,
            path: urlObject.path,
            headers: req.headers,
            agent: agent
        };

        if (protocol === 'http:' && externalProxyUrl && url.parse(externalProxyUrl).protocol === 'http:') {
            var externalURL = url.parse(externalProxyUrl);
            options.hostname = externalURL.hostname;
            options.port = externalURL.port;
            // support non-transparent proxy
            options.path = 'http://' + urlObject.host + urlObject.path;
        }

        // mark a socketId for Agent to bind socket for NTLM
        if (req.socket.customSocketId) {
            options.customSocketId = req.socket.customSocketId;
        } else if (headers['authorization']) {
            options.customSocketId = req.socket.customSocketId = socketId++;
        }

        return options;
    },
    getTunnelAgent: function getTunnelAgent(requestIsSSL, externalProxyUrl) {
        var urlObject = url.parse(externalProxyUrl);
        var protocol = urlObject.protocol || 'http:';
        var port = urlObject.port;
        if (!port) {
            port = protocol === 'http:' ? 80 : 443;
        }
        var hostname = urlObject.hostname || 'localhost';

        if (requestIsSSL) {
            if (protocol === 'http:') {
                if (!httpsOverHttpAgent) {
                    httpsOverHttpAgent = tunnelAgent.httpsOverHttp({
                        proxy: {
                            host: hostname,
                            port: port
                        }
                    });
                }
                return httpsOverHttpAgent;
            } else {
                if (!httpsOverHttpsAgent) {
                    httpsOverHttpsAgent = tunnelAgent.httpsOverHttps({
                        proxy: {
                            host: hostname,
                            port: port
                        }
                    });
                }
                return httpsOverHttpsAgent;
            }
        } else {
            if (protocol === 'http:') {
                // if (!httpOverHttpAgent) {
                //     httpOverHttpAgent = tunnelAgent.httpOverHttp({
                //         proxy: {
                //             host: hostname,
                //             port: port
                //         }
                //     })
                // }
                return false;
            } else {
                if (!httpOverHttpsAgent) {
                    httpOverHttpsAgent = tunnelAgent.httpOverHttps({
                        proxy: {
                            host: hostname,
                            port: port
                        }
                    });
                }
                return httpOverHttpsAgent;
            }
        }
    }
};

var reqTimeout = REQ_TIMEOUT;
Object.defineProperty(utils, 'reqTimeout', {
    set: function set(v) {
        reqTimeout = v * 1000;
    },
    get: function get() {
        return reqTimeout;
    }
});

var resTimeout = RES_TIMEOUT;
Object.defineProperty(utils, 'resTimeout', {
    set: function set(v) {
        resTimeout = v * 1000;
    },
    get: function get() {
        return resTimeout;
    }
});

module.exports = utils;