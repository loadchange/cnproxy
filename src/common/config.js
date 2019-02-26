const path = require('path')

let config = exports

config.caCertFileName = 'cnproxy.ca.crt'

config.caKeyFileName = 'cnproxy.ca.key.pem'

config.defaultPort = 6789

config.caName = 'CNPROXY CA'

config.getDefaultCABasePath = () => {
    let userHome = process.env.HOME || process.env.USERPROFILE
    return path.resolve(userHome, './.cnproxy')
}

config.getDefaultCACertPath = () => {
    return path.resolve(config.getDefaultCABasePath(), config.caCertFileName)
}

config.getDefaultCACertPath = () => {
    return path.resolve(config.getDefaultCABasePath(), config.caKeyFileName)
}