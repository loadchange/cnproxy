module.exports = {
    middlewares: [
        // 1. 与当地一个取代单一文件
        {
            pattern: 'homepage.js',      // 你想替换匹配url
            responder: "/Users/wangyanmin/code/github/cnproxy/start.js"
        },

        // 2. 用web文件替换单一文件
        {
            pattern: 'myvue.js',      // 你想替换匹配url
            responder: "https://cdn.bootcss.com/vue/2.5.16/vue.js"
        },

        // 3. 组合文件替换为src与绝对的文件路径
        {
            pattern: 'group/test.*.js',
            responder: [
                '/Users/wangyanmin/code/other/test/a.js',
                '/Users/wangyanmin/code/other/test/b.js',
                '/Users/wangyanmin/code/other/test/c.js'
            ]
        },

        // 4. 组合文件替换为src相对文件路径和指定的dir
        {
            pattern: 'group/test.*.js',
            responder: {
                dir: '/Users/wangyanmin/code/other/test',
                src: [
                    'a.js',
                    'b.js',
                    'c.js'
                ]
            }
        },

        // 5. 请求服务器的图片目录映射到本地图片目录
        {
            pattern: 'ui/homepage/img',  // 必须是一个字符串
            responder: '/Users/wangyanmin/Downloads/test_img' // 必须是一个绝对目录路径
        },

        // 6. 使用正则表达式
        {
            pattern: /https?:\/\/[\w\.]*(?::\d+)?\/ui\/(.*)_dev\.(\w+)/,
            responder: 'http://localhost/proxy/$1.$2'
        },

        // 7. 服务器映像目录映射到本地图像目录与正则表达式
        // 这个简单的规则可以替代多个目录相应的环境
        // 如下：
        //   http://host:port/ui/a/img/... => /home/a/image/...
        //   http://host:port/ui/b/img/... => /home/b/image/...
        //   http://host:port/ui/c/img/... => /home/c/image/...
        //   ...
        {
            pattern: /ui\/(.*)\/img\//,
            responder: '/Users/wangyanmin/Downloads/test_img/$1/img/'
        },
        // 8. 使用cookies ,单独设置某一个匹配规则的cookies，
        // 如果需要将全部匹配的url统一设置cookies
        // 可以在启动cnproxy时使用-c 'cookies...'
        {
            pattern: /http:\/\/127.0.0.1:8080\/user\/upload\/(.*)$/,
            responder: 'http://www.qq.com/vip/upload/$1',
            cookies: '_xsrf=2|330a5789|c9627c4a257a5b6067094df2d9a1e1d8|1459947169; SESSION=e8eb5e4b-2ebc-413a-9055-e5b69471146d'
        }
    ],

    // 外部代理
    externalProxy: null,

    // 是否需要走代理
    sslConnectInterceptor: function (clientReq, clientSocket, head) {
        return true
    },

    // 请求拦截器
    requestInterceptor: function (rOptions, req, res, ssl, next) {
        console.log('请求拦截器:requestInterceptor')
        console.log(`正在访问：${rOptions.protocol}//${rOptions.hostname}:${rOptions.port}`);
        console.log('cookie:', rOptions.headers.cookie);
        // res.end('HELLO CNPROXY!');
        next();
    },

    // 响应拦截
    responseInterceptor: function (req, res, proxyReq, proxyRes, ssl, next) {
        console.log('responseInterceptor')
        next();
    }
}
