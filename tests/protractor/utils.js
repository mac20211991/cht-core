var http = require('http'),
    environment = require('./auth')();

var originalSettings;

var request = function(options, debug) {
  var deferred = protractor.promise.defer();

  options.hostname = environment.apiHost;
  options.port = environment.apiPort;
  options.auth = environment.user + ':' + environment.pass;

  if (debug) {
    console.log('REQUEST');
    console.log(JSON.stringify(options));
  }

  var req = http.request(options, function(res) {
    res.setEncoding('utf8');
    var body = '';
    res.on('data', function (chunk) {
      body += chunk;
    });
    res.on('end', function () {
      try {
        deferred.fulfill(JSON.parse(body));
      } catch(e) {
        console.log('Error parsing response: ' + body);
        deferred.reject();
      }
    });
  });
  req.on('error', function(e) {
    console.log('Request failed: ' + e.message);
    deferred.reject();
  });

  if (options.body) {
    req.write(options.body);
  }
  req.end();

  return deferred.promise;
};

module.exports = {

  request: request,

  requestOnTestDb: function(options, debug) {
    options.path = '/' + environment.dbName + options.path;
    return request(options, debug);
  },

  saveDoc: function(doc) {
    var postData = JSON.stringify(doc);
    return request({
      path: '/' + environment.dbName,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      },
      body: postData
    });
  },

  getDoc: function(id) {
    return request({
      path: '/' + environment.dbName + '/' + id,
      method: 'GET'
    });
  },

  getAuditDoc: function(id) {
    return request({
      path: '/' + environment.dbName + '-audit/_design/medic/_view/audit_records_by_doc?include_docs=true&key=["' + id + '"]',
      method: 'GET'
    });
  },

  deleteDoc: function(id) {
    return module.exports.getDoc(id)
      .then(function(doc) {
        doc._deleted = true;
        return module.exports.saveDoc(doc);
      });
  },

  purgeDoc: function(id) {
    return module.exports.getDoc(id)
      .then(function(doc) {
        var b = {};
        b[doc._id] = [doc._rev];

        var postData = JSON.stringify(b);

        console.log('POST ME A PICTURE TRAVIS');
        console.log(doc._id);
        console.log(doc._rev);
        console.log(postData);

        return module.exports.requestOnTestDb({
          method: 'POST',
          path: '/_purge',
          body: postData,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': postData.length
          },
        }, true);
      })
      .then(function(result) {
        console.log('Attempted to purge ' + id);
        console.log(JSON.stringify(result));
      })
      .catch(function(err) {
        console.log('[[[[[[[[[[[[[[');
        console.log(err);
      });
  },

  updateSettings: function(updates) {
    if (originalSettings) {
      throw new Error('A previous test did not call revertSettings');
    }
    return request({
      path: '/' + environment.dbName + '/_design/medic/_rewrite/app_settings/medic',
      method: 'GET'
    }).then(function(settings) {
      originalSettings = settings;
      return request({
        path: '/' + environment.dbName + '/_design/medic/_rewrite/update_settings/medic',
        method: 'PUT',
        body: JSON.stringify(updates)
      });
    });
  },

  revertSettings: function() {
    if (!originalSettings) {
      throw new Error('No original settings to revert to');
    }
    return request({
      path: '/' + environment.dbName + '/_design/medic/_rewrite/update_settings/medic',
      method: 'PUT',
      body: JSON.stringify(originalSettings)
    }).then(function() {
      originalSettings = null;
    });
  }

};
