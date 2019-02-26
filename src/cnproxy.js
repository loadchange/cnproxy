const fs = require('fs')
const http = require('http')
const log = require('./common/log')
const utils = require('./common/utils')
const tlsUtils = require('./tls/tlsUtils')

const createRequestHandler = require('./proxy/createRequestHandler')
const createConnectHandler = require('./proxy/createConnectHandler')
const createFakeServerCenter = require('./proxy/createFakeServerCenter')
const createUpgradeHandler = require('./proxy/createUpgradeHandler')


const DEFAULT_PORT = 9010

let httpServer

/**
 * Start up cnproxy server on the specified port
 * and combine the processors defined as connect middlewares into it.
 *
 * @param {String} port the port proxy server will listen on
 * @param {Object} options options for the middlewares
 */
function cnproxy({port, config, timeout, debug, networks, watch}) {

    port = typeof port === 'number' ? port : DEFAULT_PORT

    let configuration = !watch ? utils.loadConfiguration(config) : null

    if (configuration) {
        utils.watchConfiguration(config, () => {
            configuration = utils.loadConfiguration(config)
        })
    }

    let getCertSocketTimeout = timeout || 1000

    if (typeof debug === 'boolean') {
        log.isDebug = debug
    }

    let middlewares = []
    let urlRewrite = {}
    let externalProxy = null
    // 判断该请求是否需要代理
    let sslConnectInterceptor = (clientReq, clientSocket, head) => true
    // 请求拦截器
    let requestInterceptor = (rOptions, req, res, ssl, next) => next()
    // 响应拦截器
    let responseInterceptor = (req, res, proxyReq, proxyRes, ssl, next) => next()

    if (watch) {
        let pattern = typeof watch === 'string' ? new RegExp(watch) : watch
        requestInterceptor = (requestOptions, clientReq, clientRes, ssl, next) => {
            let url = utils.processUrl(clientReq, requestOptions)
            if (pattern.test(url)) {
                console.log('\n')
                log.info('[URL]:' + url)
                log.info('[METHOD]:' + requestOptions.method)
                if (requestOptions.headers.cookie) {
                    log.info('[COOKIE]:' + requestOptions.headers.cookie)
                }
                if (requestOptions.headers['user-agent']) {
                    log.info('[USER_AGENT]:' + requestOptions.headers['user-agent'])
                }
            }
            next()
        }
    } else if (configuration) {
        if (configuration.sslConnectInterceptor) {
            sslConnectInterceptor = configuration.sslConnectInterceptor
        }
        if (configuration.requestInterceptor) {
            requestInterceptor = configuration.requestInterceptor
        }
        if (configuration.responseInterceptor) {
            responseInterceptor = configuration.responseInterceptor
        }
        if (configuration.middlewares) {
            middlewares = configuration.middlewares
        }
        if (configuration.urlRewrite) {
            urlRewrite = configuration.urlRewrite
        }
    }


    let rs = tlsUtils.initCA()
    let caKeyPath = rs.caKeyPath
    let caCertPath = rs.caCertPath

    let requestHandler = createRequestHandler(
        requestInterceptor,
        responseInterceptor,
        middlewares,
        urlRewrite,
        externalProxy
    )

    let upgradeHandler = createUpgradeHandler()

    let fakeServersCenter = createFakeServerCenter({
        caCertPath,
        caKeyPath,
        requestHandler,
        upgradeHandler,
        getCertSocketTimeout
    })

    let connectHandler = createConnectHandler(
        sslConnectInterceptor,
        fakeServersCenter
    )

    let server = new http.Server();
    server.listen(port, () => {
        log.info(`CNProxy 启动成功 端口号: ${port}!`)

        if (networks) {
            log.info('Network interfaces:');
            let interfaces = require('os').networkInterfaces()
            for (let key in interfaces) {
                log.info(key)
                interfaces[key].forEach((item) => {
                    log.info(`  ${item.address}\t${item.family}`)
                })
            }
        }

        server.on('error', (e) => log.error(e))

        server.on('request', (req, res) => {
            log.debug(req.url)
            let ssl = false;
            if (req.url === 'http://loadchange.com/getssl') {
                try {
                    let fileString = fs.readFileSync(caCertPath);
                    res.setHeader('Content-Type', 'application/x-x509-ca-cert')
                    res.end(fileString.toString());
                } catch (e) {
                    log.error(e)
                    res.end('please create certificate first!!')
                }
                return
            }
            requestHandler(req, res, ssl);
        });

        server.on('connect', (req, cltSocket, head) => connectHandler(req, cltSocket, head))

        server.on('upgrade', (req, socket, head) => {
            let ssl = false
            upgradeHandler(req, socket, head, ssl)
        })
    })

    return httpServer
}

process.on('uncaughtException', (err) => {
    log.error('uncaughtException: ' + err.message)
})

module.exports = cnproxy
