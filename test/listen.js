var path = require('path');
var targetServer = require('./support/target-server');
var proxyServer = require('../');
var replaceListPath = path.join(__dirname, 'support', 'replace-list.js');

describe('CNProxy', function(){
  var servers;
  var httpServer;
  var httpsServer;

  before(function(done){
    servers = proxyServer(undefined, replaceListPath);
    httpServer = servers.httpServer;
    httpsServer = servers.httpsServer;
    done();
  });

  describe('.listen', function(){
    it('should listen on port 9010 by default', function(done){
      done();
    });
  });

  after(function(done){
    httpServer.close();
    httpsServer.close();
    done();
  });
});