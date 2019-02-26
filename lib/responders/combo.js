'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var fs = require('fs');
var path = require('path');
var mime = require('mime');
var utils = require('../common/utils');
var log = require('../common/log');

/**
 * respond the request following the algorithm
 *
 * 1. Read the file content according to the configured src list
 * 2. Concat them into a file
 * 3. Respond the file to the request
 *
 * @param {Object} options dir and source file lists
 *                 {dir: String, src: Array}
 * @param {Object} req request
 * @param {Object} res response
 * @param {Object} next next
 */
function respondFromCombo(options, req, res, next) {
    var dir = void 0;
    var src = void 0;

    if ((typeof options === 'undefined' ? 'undefined' : _typeof(options)) !== 'object' || typeof options === null) {
        log.warn('Options are invalid when responding from combo!');
        next();
    }

    dir = typeof options.dir === 'undefined' ? null : options.dir;
    src = Array.isArray(options.src) ? options.src : [];

    if (dir !== null) {
        try {
            fs.statSync(dir);
        } catch (e) {
            throw e;
        }

        src = src.map(function (file) {
            return path.join(dir, file);
        });
    }

    //Read the local files and concat together
    if (src.length > 0) {
        utils.concat(src, function (err, data) {
            if (err) {
                throw err;
            }
            res.statusCode = 200;

            res.setHeader('Content-Length', data.length);
            res.setHeader('Content-Type', mime.getType(src[0]));
            res.setHeader('Server', 'CNPROXY');

            res.write(data);
            res.end();
            next();
        });
    }
}

module.exports = respondFromCombo;