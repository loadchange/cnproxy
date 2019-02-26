'use strict';

var colors = require('colors');

colors.setTheme({
    info: 'green',
    warn: 'yellow',
    error: 'red',
    debug: 'blue'
});

var TYPE = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

var log = {
    print: function print(type, msg) {
        var logType = TYPE;

        switch (type) {
            case logType.ERROR:
                console.log(('[ERROR] ' + msg).error);
                break;

            case logType.WARN:
                console.log(('[WARN] ' + msg).warn);
                break;

            case logType.INFO:
                console.log(('[INFO] ' + msg).info);
                break;

            case logType.DEBUG:
                console.log(('[DEBUG] ' + msg).debug);
                break;
        }
    },
    info: function info(msg) {
        log.print(TYPE.INFO, msg);
    },
    warn: function warn(msg) {
        log.print(TYPE.WARN, msg);
    },
    error: function error(msg) {
        log.print(TYPE.ERROR, msg);
    },
    debug: function debug(msg) {
        if (log.isDebug) {
            log.print(TYPE.DEBUG, msg);
        }
    }
};

var isDebug = false;
Object.defineProperty(log, 'isDebug', {
    set: function set(value) {
        isDebug = value;
    },
    get: function get() {
        return isDebug;
    }
});

module.exports = log;