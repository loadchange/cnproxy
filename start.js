var cnproxy = require('./');

var options = {
  timeout: 10,
  debug: true
}

var port = 9010;
cnproxy(port, options );
