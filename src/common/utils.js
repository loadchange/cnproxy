const fs = require('fs')
const os = require('os')
const url = require('url')
const http = require('http')
const path = require('path')
const Step = require('step')
const https = require('https')
const constants = require('constants')
const Buffer = require('buffer').Buffer
const tunnelAgent = require('tunnel-agent')

const log = require('./log')
const Agent = require('./ProxyHttpAgent')
const HttpsAgent = require('./ProxyHttpsAgent')

let httpsAgent = new HttpsAgent({
    keepAlive: true,
    timeout: 60000,
    keepAliveTimeout: 30000, // free socket keepalive for 30 seconds
    rejectUnauthorized: false
})
let httpAgent = new Agent({
    keepAlive: true,
    timeout: 60000,
    keepAliveTimeout: 30000 // free socket keepalive for 30 seconds
})
let socketId = 0

let httpOverHttpAgent, httpsOverHttpAgent, httpOverHttpsAgent, httpsOverHttpsAgent


const REQ_TIMEOUT = 10 * 1000
const RES_TIMEOUT = 10 * 1000

http.globalAgent.maxSockets = 25
https.globalAgent.maxSockets = 25

/**
 * Load file without cache
 *
 * @return {Array} load list from a file
 */
function _loadFile(filename) {
    let module = require(filename)
    delete require.cache[require.resolve(filename)]
    return module
}

let utils = {
    loadConfiguration(filePath) {
        if (typeof filePath !== 'string') {
            return null
        }
        if (!fs.existsSync(filePath)) {
            throw new Error('File doesn\'t exist!')
        }
        if (!utils.isAbsolutePath(filePath)) {
            filePath = path.join(process.cwd(), filePath)
        }
        return _loadFile(filePath)
    },
    watchConfiguration(filePath, callback) {
        fs.watchFile(filePath, (curr, prev) => {
            log.warn('The rule file has been modified!')
            callback()
        })
    },
    /**
     * Process url with valid format especially in https cases
     * in which, req.url doesn't include protocol and host
     *
     * @param {Object} req
     */
    processUrl(req, rOptions) {
        let hostArr = req.headers.host.split(':')
        let hostname = hostArr[0]
        let port = hostArr[1]

        let parsedUrl = url.parse(req.url, true)
        parsedUrl.protocol = parsedUrl.protocol || (req.type ? req.type + ':' : null) || rOptions.protocol
        parsedUrl.hostname = parsedUrl.hostname || hostname

        if (!parsedUrl.port && port) {
            parsedUrl.port = port
        }

        return url.format(parsedUrl)
    },

    processUrlWithQSAbandoned(urlStr) {
        return urlStr.replace(/\?.*$/, '')
    },

    /**
     * Simple wrapper for the default http.request
     *
     * @param {Object} options options about url, method and headers
     * @param {Function} callback callback to handle the response object
     */
    request(options, callback) {
        let parsedUrl
        let requestUrl
        let requestMethod
        let requestHeaders
        let requestHandler
        let requestOptions
        let request
        let sender
        let requestTimeout
        let responseTimeout
        let buffers

        if (typeof callback !== 'function') {
            log.error('No callback specified!')
            return
        }

        requestHandler = callback

        if (typeof options !== 'object') {
            requestHandler(new Error('No options specified!'))
            return
        }

        requestUrl = options.url

        if (typeof requestUrl === 'undefined') {
            requestHandler(new Error('No url specified!'))
            return
        }

        try {
            requestUrl = url.parse(requestUrl)
        } catch (e) {
            requestHandler(new Error('Invalid url'))
            return
        }

        requestMethod = options.method || 'GET'
        requestHeaders = options.headers

        requestOptions = {
            hostname: requestUrl.hostname || 'localhost',
            port: requestUrl.port || (requestUrl.protocol === 'https:' ? 443 : 80),
            method: requestMethod,
            path: requestUrl.path,
            rejectUnauthorized: false,
            secureOptions: constants.SSL_OP_NO_TLSv1_2 // degrade the SSL version as v0.8.x used
        }

        if (typeof requestHeaders === 'object') {
            requestOptions.headers = requestHeaders
        }

        sender = requestUrl.protocol === 'https:' ? https : http

        requestTimeout = setTimeout(function () {
            log.error('Request timeout for ' + options.url)
            requestTimeout = null
            request.abort()
            requestHandler(new Error('Request Timtout'))
        }, utils.reqTimeout)

        log.debug('Send ' + requestMethod + ' for ' + options.url + ' at ' + new Date())
        request = sender.request(requestOptions, function (res) {
            log.debug('Finish ' + requestMethod + ' the request for ' + options.url + ' at ' + new Date())

            clearTimeout(requestTimeout)
            responseTimeout = setTimeout(function () {
                log.error('Response timeout for ' + requestMethod + ' ' + options.url)
                responseTimeout = null
                request.abort()
                requestHandler(new Error('Response timeout'))
            }, utils.resTimeout)

            buffers = []
            res.on('data', function (chunk) {
                buffers.push(chunk)
            })

            res.on('end', function () {
                log.debug('Get the response of ' + requestMethod + ' ' + options.url + ' at ' + new Date())
                if (responseTimeout) {
                    clearTimeout(responseTimeout)
                }
                requestHandler(null, Buffer.concat(buffers), res)
            })
        })

        if (utils.isContainBodyData(requestMethod)) {
            request.write(options.data)
        }

        request.on('error', function (err) {
            log.error('url: ' + options.url)
            log.error('msg: ' + err.message)

            if (requestTimeout) {
                clearTimeout(requestTimeout)
            }

            requestHandler(err)
        })

        request.end()
    },

    /**
     * Concat files in the file list into one single file
     *
     * @param {Array} fileList
     * @param {String} dest the path of dest file
     *
     */
    concat(fileList, cb) {
        let group
        let buffers = []
        if (!Array.isArray(fileList)) {
            log.error('fileList is not a Array!')
            return
        }

        log.info('Start combine ' + fileList.length + ' files')

        Step(
            function readFiles() {
                group = this.group()

                fileList.forEach(function (file) {
                    fs.readFile(file, group())
                })
            },

            /**
             * Receive all the file contents
             *
             * @param {Object} err
             * @param {Array} files Buffer list
             */
            function concatAll(err, files) {
                if (err) {
                    cb(err)
                }
                log.info('Finish combination!')
                cb(null, Buffer.concat(utils._appendEnter(files)))
            }
        )
    },

    /**
     * This is a hack function to avoid the grammer issue when concating files
     *
     * @param {Array} files buffer array containing the file contents
     *
     * @return {Array} buffer array containing the file contents and appended enter character
     */
    _appendEnter(files) {
        let newBuffers = []
        files.forEach(function (buffer) {
            newBuffers.push(buffer)
            newBuffers.push(new Buffer('\n'))
        })

        return newBuffers
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
    findFile(directory, filename, callback) {
        Step(
            function readDirectory() {
                fs.readdir(directory, this)
            },

            function stat(err, files) {
                let {group, file, matchedStore = [], stat1, index} = {}

                if (err) {
                    callback(err)
                    return
                }

                for (let i = 0, l = files.length; i < l; i++) {
                    file = files[i]

                    try {
                        stat1 = fs.statSync(path.join(directory, file))
                    } catch (e) {
                        log.error(e.message)
                        continue
                    }

                    if (stat1.isFile()) {
                        index = path.basename(filename, path.extname(filename))
                            .indexOf(path.basename(file, path.extname(file)))

                        if (index !== -1 && path.extname(filename) === path.extname(file)) {
                            matchedStore.push(file)
                        }
                    }
                }

                return matchedStore

            },

            function match(err, matchedResults) {
                let matchedFile

                matchedResults.forEach((item) => {
                    if (typeof matchedFile === 'undefined') {
                        matchedFile = item
                    } else {
                        matchedFile = item.length > matchedFile.length
                            ? item
                            : matchedFile
                    }
                })

                if (typeof matchedFile === 'undefined') {
                    callback(new Error('No file matched with ' + filename))
                } else {
                    callback(null, path.join(directory, matchedFile))
                }
            }
        )
    },

    /**
     * Is the path a absolute path
     *
     * @param {String} filePath
     * @return {Boolean}
     */
    isAbsolutePath(filePath) {
        if (typeof filePath !== 'string') {
            return false
        }

        if (os.platform && os.platform() === 'win32') {
            return filePath.indexOf(':') !== -1
        } else {
            return filePath.indexOf(path.sep) === 0
        }
    },

    /**
     * Does the HTTP request contain body data
     *
     * @param {String} HTTP method token
     *
     * @return {Boolean}
     */
    isContainBodyData(method) {
        if (!method) {
            return false
        }

        let white_list = ['POST', 'PUT']
        return white_list.some((i) => {
            return i === method
        })
    },
    getOptionsFormRequest(req, ssl, externalProxy = null) {
        let urlObject = url.parse(req.url)
        let defaultPort = ssl ? 443 : 80
        let protocol = ssl ? 'https:' : 'http:'
        let headers = Object.assign({}, req.headers)
        let externalProxyUrl = null

        if (externalProxy) {
            if (typeof externalProxy === 'string') {
                externalProxyUrl = externalProxy
            } else if (typeof externalProxy === 'function') {
                try {
                    externalProxyUrl = externalProxy(req, ssl)
                } catch (e) {
                    console.error(e)
                }
            }
        }

        delete headers['proxy-connection']
        let agent = false
        if (!externalProxyUrl) {
            // keepAlive
            if (headers.connection !== 'close') {
                if (protocol === 'https:') {
                    agent = httpsAgent
                } else {
                    agent = httpAgent
                }
                headers.connection = 'keep-alive'
            }
        } else {
            agent = util.getTunnelAgent(protocol === 'https:', externalProxyUrl)
        }

        let options = {
            protocol: protocol,
            hostname: req.headers.host.split(':')[0],
            method: req.method,
            port: req.headers.host.split(':')[1] || defaultPort,
            path: urlObject.path,
            headers: req.headers,
            agent: agent
        }

        if (protocol === 'http:' && externalProxyUrl && (url.parse(externalProxyUrl)).protocol === 'http:') {
            let externalURL = url.parse(externalProxyUrl)
            options.hostname = externalURL.hostname
            options.port = externalURL.port
            // support non-transparent proxy
            options.path = `http://${urlObject.host}${urlObject.path}`
        }

        // mark a socketId for Agent to bind socket for NTLM
        if (req.socket.customSocketId) {
            options.customSocketId = req.socket.customSocketId
        } else if (headers['authorization']) {
            options.customSocketId = req.socket.customSocketId = socketId++
        }

        return options

    },

    getTunnelAgent(requestIsSSL, externalProxyUrl) {
        let urlObject = url.parse(externalProxyUrl)
        let protocol = urlObject.protocol || 'http:'
        let port = urlObject.port
        if (!port) {
            port = protocol === 'http:' ? 80 : 443
        }
        let hostname = urlObject.hostname || 'localhost'

        if (requestIsSSL) {
            if (protocol === 'http:') {
                if (!httpsOverHttpAgent) {
                    httpsOverHttpAgent = tunnelAgent.httpsOverHttp({
                        proxy: {
                            host: hostname,
                            port: port
                        }
                    })
                }
                return httpsOverHttpAgent
            } else {
                if (!httpsOverHttpsAgent) {
                    httpsOverHttpsAgent = tunnelAgent.httpsOverHttps({
                        proxy: {
                            host: hostname,
                            port: port
                        }
                    })
                }
                return httpsOverHttpsAgent
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
                return false
            } else {
                if (!httpOverHttpsAgent) {
                    httpOverHttpsAgent = tunnelAgent.httpOverHttps({
                        proxy: {
                            host: hostname,
                            port: port
                        }
                    })
                }
                return httpOverHttpsAgent
            }
        }
    }
}

let reqTimeout = REQ_TIMEOUT
Object.defineProperty(utils, 'reqTimeout', {
    set(v) {
        reqTimeout = v * 1000
    },
    get() {
        return reqTimeout
    }
})

let resTimeout = RES_TIMEOUT
Object.defineProperty(utils, 'resTimeout', {
    set(v) {
        resTimeout = v * 1000
    },
    get() {
        return resTimeout
    }
})

module.exports = utils