const colors = require('colors')

colors.setTheme({
    info: 'green',
    warn: 'yellow',
    error: 'red',
    debug: 'blue'
})

const TYPE = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
}

const log = {
    print(type, msg) {
        let logType = TYPE

        switch (type) {
            case logType.ERROR:
                console.log(`[ERROR] ${msg}`.error)
                break

            case logType.WARN:
                console.log(`[WARN] ${msg}`.warn)
                break

            case logType.INFO:
                console.log(`[INFO] ${msg}`.info)
                break

            case logType.DEBUG:
                console.log(`[DEBUG] ${msg}`.debug)
                break
        }
    },

    info(msg) {
        log.print(TYPE.INFO, msg)
    },

    warn(msg) {
        log.print(TYPE.WARN, msg)
    },

    error(msg) {
        log.print(TYPE.ERROR, msg)
    },

    debug(msg) {
        if (log.isDebug) {
            log.print(TYPE.DEBUG, msg)
        }
    }
}

let isDebug = false
Object.defineProperty(log, 'isDebug', {
    set(value) {
        isDebug = value
    },
    get() {
        return isDebug
    }
})

module.exports = log