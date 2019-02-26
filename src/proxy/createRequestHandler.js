const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const log = require('../common/log')
const commonUtil = require('../common/utils')
const responders = require('../responders')

const httpRxg = /^http/

let extDirectoryOfRequestUrl
let localDirectory

// create requestHandler function
module.exports = function createRequestHandler(requestInterceptor, responseInterceptor, middlewares, urlRewrite, externalProxy) {

    return function requestHandler(req, res, ssl) {

        let proxyReq

        let rOptions = commonUtil.getOptionsFormRequest(req, ssl, externalProxy)

        if (rOptions.headers.connection === 'close') {
            req.socket.setKeepAlive(false)
        } else if (rOptions.customSocketId !== null) {
            req.socket.setKeepAlive(true, 60 * 60 * 1000)
        } else {
            req.socket.setKeepAlive(true, 30000)
        }

        let requestInterceptorPromise = () => {
            return new Promise((resolve, reject) => {

                let next = () => {
                    resolve()
                }

                let url = commonUtil.processUrl(req, rOptions)
                log.debug('respond: ' + url)

                let respondObj, originalPattern, responder, pattern, cookies

                if (Object.keys(urlRewrite).length) {
                    let newUrl = url;
                    for (const key in urlRewrite) {
                        newUrl = newUrl.replace(key, urlRewrite[key]);
                    }
                    responders.respondFromWebFile(newUrl, req, res, next)
                    return
                }

                for (let i = 0, len = middlewares.length; i < len; i++) {
                    respondObj = middlewares[i]
                    originalPattern = respondObj.pattern
                    responder = respondObj.responder
                    cookies = respondObj.cookies

                    // adapter pattern to RegExp object
                    if (typeof originalPattern !== 'string' && !(originalPattern instanceof RegExp)) {
                        log.error()
                        throw new Error('pattern must be a RegExp Object or a string for RegExp')
                    }

                    pattern = typeof originalPattern === 'string' ? new RegExp(originalPattern) : originalPattern


                    if (pattern.test(url)) {

                        log.debug(`匹配:${originalPattern}`)

                        responder = fixResponder(url, pattern, responder)

                        if (cookies) {
                            req.headers.cookie = cookies
                        }

                        if (typeof responder === 'string') {
                            if (httpRxg.test(responder)) {
                                responders.respondFromWebFile(responder, req, res, next)
                            } else {
                                fs.stat(responder, (err, stat) => {
                                    if (err) {
                                        log.error(`${err.message} for ${url} then directly forward it!`)
                                        next()
                                        return
                                    }
                                    if (stat.isFile()) { // local file
                                        responders.respondFromLocalFile(responder, req, res, next)
                                    } else if (stat.isDirectory()) { // directory mapping
                                        let urlWithoutQS = commonUtil.processUrlWithQSAbandoned(url)
                                        let directoryPattern = url.match(pattern)[0]
                                        extDirectoryOfRequestUrl = urlWithoutQS.substr(urlWithoutQS.indexOf(directoryPattern) + directoryPattern.length)
                                        localDirectory = path.join(responder, path.dirname(extDirectoryOfRequestUrl))

                                        commonUtil.findFile(localDirectory, path.basename(extDirectoryOfRequestUrl), (err, file) => {
                                                log.debug(`Find local file: ${file} for (${url})`)
                                                if (err) {
                                                    log.error(`${err.message} for (${url})' then directly forward it!`)
                                                    next()
                                                } else {
                                                    responders.respondFromLocalFile(file, req, res, next);
                                                }
                                            }
                                        )
                                    }
                                })
                            }
                        } else if (Array.isArray(responder)) {
                            responders.respondFromCombo({dir: null, src: responder}, req, res, next)
                        } else if (typeof responder === 'object' && responder !== null) {
                            responders.respondFromCombo({dir: responder.dir, src: responder.src}, req, res, next)
                        } else {
                            log.error(`Responder for ${url} is invalid!`)
                        }
                        return
                    }
                }

                try {
                    if (typeof requestInterceptor === 'function') {
                        requestInterceptor.call(null, rOptions, req, res, ssl, next)
                    } else {
                        resolve()
                    }
                } catch (e) {
                    reject(e)
                }
            })
        }

        let proxyRequestPromise = () => {
            return new Promise((resolve, reject) => {

                rOptions.host = rOptions.hostname || rOptions.host || 'localhost'

                // use the binded socket for NTLM
                if (rOptions.agent && rOptions.customSocketId != null && rOptions.agent.getName) {
                    let socketName = rOptions.agent.getName(rOptions)
                    let bindingSocket = rOptions.agent.sockets[socketName]
                    if (bindingSocket && bindingSocket.length > 0) {
                        bindingSocket[0].once('free', onFree)
                        return
                    }
                }
                onFree()

                function onFree() {
                    proxyReq = (rOptions.protocol === 'https:' ? https : http).request(rOptions, (proxyRes) => {
                        resolve(proxyRes)
                    })
                    proxyReq.on('timeout', () => {
                        reject(`${rOptions.host}:${rOptions.port}, request timeout`)
                    })

                    proxyReq.on('error', (e) => {
                        reject(e)
                    })

                    proxyReq.on('aborted', () => {
                        reject('server aborted reqest')
                        req.abort()
                    })

                    req.on('aborted', function () {
                        proxyReq.abort()
                    })
                    req.pipe(proxyReq)

                }

            })
        }

        // workflow control
        (async () => {

            await requestInterceptorPromise()

            if (res.finished) {
                return false
            }

            let proxyRes = await proxyRequestPromise()


            let responseInterceptorPromise = new Promise((resolve, reject) => {
                let next = () => {
                    resolve()
                }
                try {
                    if (typeof responseInterceptor === 'function') {
                        responseInterceptor.call(null, req, res, proxyReq, proxyRes, ssl, next)
                    } else {
                        resolve()
                    }
                } catch (e) {
                    reject(e)
                }
            })

            await responseInterceptorPromise

            if (res.finished) {
                return false
            }

            try {
                if (!res.headersSent) {
                    Object.keys(proxyRes.headers).forEach(function (key) {
                        if (proxyRes.headers[key] !== undefined) {
                            if (/^www-authenticate$/i.test(key)) {
                                if (proxyRes.headers[key]) {
                                    proxyRes.headers[key] = proxyRes.headers[key] && proxyRes.headers[key].split(',')
                                }
                                key = 'www-authenticate'
                            }
                            res.setHeader(key, proxyRes.headers[key])
                        }
                    })

                    res.writeHead(proxyRes.statusCode)
                    proxyRes.pipe(res)
                }
            } catch (e) {
                throw e
            }
        })().then((flag) => {
            },
            (e) => {
                if (!res.finished) {
                    res.writeHead(500)
                    res.write(`CNProxy Warning:\n\n ${e.toString()}`)
                    res.end()
                }
                console.error(e)
            }
        )
    }
}

/**
 * For some responder with regular expression variable like $1, $2,
 * it should be replaced with the actual value
 *
 * @param {Regular Express Object} pattern matched array
 * @param {String} responder, replaced string
 */
function fixResponder(url, pattern, responder) {
    let $v = /\$\d+/g
    let m
    let newRx
    if (!$v.test(responder)) {
        return responder
    }

    m = url.match(pattern)

    if (!Array.isArray(m)) {
        return responder
    }

    for (var i = 0, l = m.length; i < l; i++) {
        newRx = new RegExp('\\$' + i, 'g');
        responder = responder.replace(newRx, m[i])
    }

    return responder
}
