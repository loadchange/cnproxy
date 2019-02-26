'use strict';

var fs = require('fs');
var http = require('http');
var log = require('./common/log');
var utils = require('./common/utils');
var tlsUtils = require('./tls/tlsUtils');

var createRequestHandler = require('./proxy/createRequestHandler');
var createConnectHandler = require('./proxy/createConnectHandler');
var createFakeServerCenter = require('./proxy/createFakeServerCenter');
var createUpgradeHandler = require('./proxy/createUpgradeHandler');

var DEFAULT_PORT = 9010;

var httpServer = void 0;

/**
 * Start up cnproxy server on the specified port
 * and combine the processors defined as connect middlewares into it.
 *
 * @param {String} port the port proxy server will listen on
 * @param {Object} options options for the middlewares
 */
function cnproxy(_ref) {
    var port = _ref.port,
        config = _ref.config,
        timeout = _ref.timeout,
        debug = _ref.debug,
        networks = _ref.networks,
        watch = _ref.watch;


    port = typeof port === 'number' ? port : DEFAULT_PORT;

    var configuration = !watch ? utils.loadConfiguration(config) : null;

    if (configuration) {
        utils.watchConfiguration(config, function () {
            configuration = utils.loadConfiguration(config);
        });
    }

    var getCertSocketTimeout = timeout || 1000;

    if (typeof debug === 'boolean') {
        log.isDebug = debug;
    }

    var middlewares = [];
    var urlRewrite = {};
    var externalProxy = null;
    // 判断该请求是否需要代理
    var sslConnectInterceptor = function sslConnectInterceptor(clientReq, clientSocket, head) {
        return true;
    };
    // 请求拦截器
    var requestInterceptor = function requestInterceptor(rOptions, req, res, ssl, next) {
        return next();
    };
    // 响应拦截器
    var responseInterceptor = function responseInterceptor(req, res, proxyReq, proxyRes, ssl, next) {
        return next();
    };

    if (watch) {
        var pattern = typeof watch === 'string' ? new RegExp(watch) : watch;
        requestInterceptor = function requestInterceptor(requestOptions, clientReq, clientRes, ssl, next) {
            var url = utils.processUrl(clientReq, requestOptions);
            if (pattern.test(url)) {
                console.log('\n');
                log.info('[URL]:' + url);
                log.info('[METHOD]:' + requestOptions.method);
                if (requestOptions.headers.cookie) {
                    log.info('[COOKIE]:' + requestOptions.headers.cookie);
                }
                if (requestOptions.headers['user-agent']) {
                    log.info('[USER_AGENT]:' + requestOptions.headers['user-agent']);
                }
            }
            next();
        };
    } else if (configuration) {
        if (configuration.sslConnectInterceptor) {
            sslConnectInterceptor = configuration.sslConnectInterceptor;
        }
        if (configuration.requestInterceptor) {
            requestInterceptor = configuration.requestInterceptor;
        }
        if (configuration.responseInterceptor) {
            responseInterceptor = configuration.responseInterceptor;
        }
        if (configuration.middlewares) {
            middlewares = configuration.middlewares;
        }
        if (configuration.urlRewrite) {
            urlRewrite = configuration.urlRewrite;
        }
    }

    var rs = tlsUtils.initCA();
    var caKeyPath = rs.caKeyPath;
    var caCertPath = rs.caCertPath;

    var requestHandler = createRequestHandler(requestInterceptor, responseInterceptor, middlewares, urlRewrite, externalProxy);

    var upgradeHandler = createUpgradeHandler();

    var fakeServersCenter = createFakeServerCenter({
        caCertPath: caCertPath,
        caKeyPath: caKeyPath,
        requestHandler: requestHandler,
        upgradeHandler: upgradeHandler,
        getCertSocketTimeout: getCertSocketTimeout
    });

    var connectHandler = createConnectHandler(sslConnectInterceptor, fakeServersCenter);

    var server = new http.Server();
    server.listen(port, function () {
        log.info('CNProxy \u542F\u52A8\u6210\u529F \u7AEF\u53E3\u53F7: ' + port + '!');

        if (networks) {
            log.info('Network interfaces:');
            var interfaces = require('os').networkInterfaces();
            for (var key in interfaces) {
                log.info(key);
                interfaces[key].forEach(function (item) {
                    log.info('  ' + item.address + '\t' + item.family);
                });
            }
        }

        server.on('error', function (e) {
            return log.error(e);
        });

        server.on('request', function (req, res) {
            log.debug(req.url);
            var ssl = false;
            if (req.url === 'http://loadchange.com/getssl') {
                try {
                    var fileString = fs.readFileSync(caCertPath);
                    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
                    res.end(fileString.toString());
                } catch (e) {
                    log.error(e);
                    res.end('please create certificate first!!');
                }
                return;
            }
            requestHandler(req, res, ssl);
        });

        server.on('connect', function (req, cltSocket, head) {
            return connectHandler(req, cltSocket, head);
        });

        server.on('upgrade', function (req, socket, head) {
            var ssl = false;
            upgradeHandler(req, socket, head, ssl);
        });
    });

    return httpServer;
}

process.on('uncaughtException', function (err) {
    log.error('uncaughtException: ' + err.message);
});

module.exports = cnproxy;