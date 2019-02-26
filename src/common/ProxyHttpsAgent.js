const HttpsAgentOrigin = require('agentkeepalive').HttpsAgent

module.exports = class HttpsAgent extends HttpsAgentOrigin {
    getName(option) {
        let name = new HttpsAgentOrigin().getName.call(this, option)
        name += ':'
        if (option.customSocketId) {
            name += option.customSocketId
        }
        return name
    }
}