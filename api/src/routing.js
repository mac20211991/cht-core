const _ = require('lodash');
const bodyParser = require('body-parser');
const express = require('express');
const morgan = require('morgan');
const helmet = require('helmet');
const environment = require('./environment');
const db = require('./db');
const path = require('path');
const auth = require('./auth');
const logger = require('./logger');
const isClientHuman = require('./is-client-human');
const target = 'http://' + environment.host + ':' + environment.port;
const proxy = require('http-proxy').createProxyServer({ target: target });
const proxyForAuth = require('http-proxy').createProxyServer({
  target: target,
  selfHandleResponse: true,
});
const proxyForChanges = require('http-proxy').createProxyServer({
  target: target,
  selfHandleResponse: true,
});
const login = require('./controllers/login');
const smsGateway = require('./controllers/sms-gateway');
const exportData = require('./controllers/export-data');
const records = require('./controllers/records');
const forms = require('./controllers/forms');
const users = require('./controllers/users');
const places = require('./controllers/places');
const people = require('./controllers/people');
const upgrade = require('./controllers/upgrade');
const settings = require('./controllers/settings');
const bulkDocs = require('./controllers/bulk-docs');
const monitoring = require('./controllers/monitoring');
const africasTalking = require('./controllers/africas-talking');
const rapidPro = require('./controllers/rapidpro');
const infodoc = require('./controllers/infodoc');
const authorization = require('./middleware/authorization');
const deprecation = require('./middleware/deprecation');
const hydration = require('./controllers/hydration');
const contactsByPhone = require('./controllers/contacts-by-phone');
const createUserDb = require('./controllers/create-user-db');
const purgedDocsController = require('./controllers/purged-docs');
const couchConfigController = require('./controllers/couch-config');
const replicationLimitLogController = require('./controllers/replication-limit-log');
const staticResources = /\/(templates|static)\//;
// CouchDB is very relaxed in matching routes
const routePrefix = '/+' + environment.db + '/+';
const pathPrefix = '/' + environment.db + '/';
const appPrefix = pathPrefix + '_design/' + environment.ddoc + '/_rewrite/';
const adminAppPrefix = pathPrefix + '_design/medic-admin/_rewrite/';
const serverUtils = require('./server-utils');
const uuid = require('uuid');
const compression = require('compression');
const BUILDS_DB = 'https://staging.dev.medicmobile.org/_couch/builds/'; // jshint ignore:line
const cookie = require('./services/cookie');
const app = express();

// requires content-type application/json header
const jsonParser = bodyParser.json({ limit: '32mb' });
const jsonQueryParser = require('./middleware/query-parser').json;
const extractedResourceDirectory = environment.getExtractedResourcesPath();

const handleJsonRequest = (method, path, callback) => {
  app[method](path, jsonParser, (req, res, next) => {
    const contentType = req.headers['content-type'];
    if (!contentType || contentType !== 'application/json') {
      return serverUtils.error(
        {
          code: 400,
          message: 'Content-Type must be application/json',
        },
        req,
        res
      );
    } else {
      callback(req, res, next);
    }
  });
};
app.deleteJson = (path, callback) =>
  handleJsonRequest('delete', path, callback);
app.postJson = (path, callback) => handleJsonRequest('post', path, callback);
app.putJson = (path, callback) => handleJsonRequest('put', path, callback);

// requires content-type application/x-www-form-urlencoded header
const formParser = bodyParser.urlencoded({ limit: '32mb', extended: false });

// requires content-type text/plain or application/xml header
const textParser = bodyParser.text({limit: '32mb', type: [ 'text/plain', 'application/xml' ]});

app.set('strict routing', true);
app.set('trust proxy', true);

// When testing random stuff in-browser, it can be useful to access the database
// from different domains (e.g. localhost:5988 vs localhost:8080).  Adding the
// --allow-cors commandline switch will enable this from within a web browser.
if (process.argv.slice(2).includes('--allow-cors')) {
  logger.warn('WARNING: allowing CORS requests to API!');
  app.use((req, res, next) => {
    res.setHeader(
      'Access-Control-Allow-Origin',
      req.headers.origin || req.headers.host
    );
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, OPTIONS, HEAD, DELETE'
    );
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    next();
  });
}

app.use((req, res, next) => {
  req.id = uuid.v4();
  next();
});

morgan.token('id', req => req.id);

app.use(
  morgan('REQ :id :remote-addr :remote-user :method :url HTTP/:http-version', {
    immediate: true,
  })
);
app.use(
  morgan(
    'RES :id :remote-addr :remote-user :method :url HTTP/:http-version :status :res[content-length] :response-time ms'
  )
);

app.use(
  helmet({
    // runs with a bunch of defaults: https://github.com/helmetjs/helmet
    hpkp: false, // explicitly block dangerous header
    contentSecurityPolicy: {
      directives: {
        defaultSrc: [`'none'`],
        fontSrc: [`'self'`],
        manifestSrc: [`'self'`],
        connectSrc: [
          `'self'`,
          BUILDS_DB,
          'maps.googleapis.com' // used for enketo geopoint widget
        ],
        childSrc:  [`'self'`],
        formAction: [`'self'`],
        imgSrc: [
          `'self'`,
          'data:', // unsafe
          'blob:',
          '*.openstreetmap.org', // used for enketo geopoint widget
        ],
        mediaSrc: [
          `'self'`,
          'blob:',
        ],
        scriptSrc: [
          `'self'`,
          // Explicitly allow the telemetry script setting startupTimes
          `'sha256-B5cfIVb4/wnv2ixHP03bHeMXZDszDL610YG5wdDq/Tc='`,
          // AngularJS and several dependencies require this
          `'unsafe-eval'`
        ],
        styleSrc: [
          `'self'`,
          `'unsafe-inline'` // angular-ui-bootstrap
        ],
      },
      browserSniff: false,
    },
  })
);

// requires `req` header `Accept-Encoding` to be `gzip` or `deflate`
// requires `res` `Content-Type` to be compressible (see https://github.com/jshttp/mime-db/blob/master/db.json)
// default threshold is 1KB

const additionalCompressibleTypes = ['application/x-font-ttf','font/ttf'];
app.use(compression({
  filter: (req, res) => {
    if (additionalCompressibleTypes.includes(res.getHeader('Content-Type'))) {
      return true;
    }
    // fallback to standard filter function
    return compression.filter(req, res);
  }
}));

// TODO: investigate blocking writes to _users from the outside. Reads maybe as well, though may be harder
//       https://github.com/medic/medic/issues/4089

app.get('/', function(req, res) {
  if (req.headers.accept === 'application/json') {
    // CouchDB request for /dbinfo from previous versions
    // Required for service compatibility during upgrade.
    proxy.web(req, res);
  } else {
    res.sendFile(path.join(extractedResourceDirectory, 'index.html')); // Webapp's index - entry point
  }
});

app.get('/dbinfo', (req, res) => {
  req.url = '/';
  proxy.web(req, res);
});

app.get(
  [`/medic/_design/medic/_rewrite/`, appPrefix],
  (req, res) => res.sendFile(path.join(__dirname, 'public/appcache-upgrade.html'))
);

app.all('/+medic(/*)?', (req, res, next) => {
  if (environment.db !== 'medic') {
    req.url = req.url.replace(/\/medic\/?/, pathPrefix);
  }
  next();
});

app.all('/+admin(/*)?', (req, res, next) => {
  req.url = req.url.replace(/\/admin\/?/, adminAppPrefix);
  next();
});

app.get('/favicon.ico', (req, res) => {
  // Cache for a week. Normally we don't interfere with couch headers, but
  // due to Chrome (including Android WebView) aggressively requesting
  // favicons on every page change and window.history update
  // ( https://github.com/medic/medic/issues/1913 ), we have to
  // stage an intervention
  writeHeaders(req, res, [['Cache-Control', 'public, max-age=604800']]);
  db.medic.get('branding').then(doc => {
    db.medic.getAttachment(doc._id, doc.resources.favicon).then(blob => {
      res.send(blob);
    });
  }).catch(err => {
    res.sendFile('resources/ico/favicon.ico' , { root : __dirname });
    logger.warn('Branding doc or/and favicon missing: %o', err);
  });
});

app.use(express.static(path.join(__dirname, '../build/public')));
app.use(express.static(extractedResourceDirectory));
app.get(routePrefix + 'login', login.get);
app.get(routePrefix + 'login/identity', login.getIdentity);
app.postJson(routePrefix + 'login', login.post);
app.get(routePrefix + 'login/token/:token?', login.tokenGet);
app.postJson(routePrefix + 'login/token/:token?', login.tokenPost);

// saves CouchDB _session information as `userCtx` in the `req` object
app.use(authorization.getUserCtx);

// authorization for `_compact`, `_view_cleanup`, `_revs_limit` endpoints is handled by CouchDB
const ONLINE_ONLY_ENDPOINTS = [
  '_design/*/_list/*',
  '_design/*/_show/*',
  '_design/*/_view/*',
  '_find(/*)?',
  '_explain(/*)?',
  '_index(/*)?',
  '_ensure_full_commit(/*)?',
  '_security(/*)?',
  '_purge(/*)?',
];

// block offline users from accessing some unaudited CouchDB endpoints
ONLINE_ONLY_ENDPOINTS.forEach(url =>
  app.all(routePrefix + url, authorization.offlineUserFirewall)
);

// allow anyone to access their session
app.all('/_session', function(req, res) {
  const given = cookie.get(req, 'userCtx');
  if (given) {
    // update the expiry date on the cookie to keep it fresh
    cookie.setUserCtx(res, decodeURIComponent(given));
  }
  proxy.web(req, res);
});

const UNAUDITED_ENDPOINTS = [
  // This takes arbitrary JSON, not whole documents with `_id`s, so it's not
  // auditable in our current framework
  // Replication machinery we don't care to audit
  routePrefix + '_local/*',
  routePrefix + '_revs_diff',
  routePrefix + '_missing_revs',
  // NB: _changes, _all_docs, _bulk_get are dealt with elsewhere:
  // see `changesHandler`, `allDocsHandler`, `bulkGetHandler`
  routePrefix + '_design/*/_list/*',
  routePrefix + '_design/*/_show/*',
  routePrefix + '_design/*/_view/*',
  // Interacting with mongo filters uses POST
  routePrefix + '_find',
  routePrefix + '_explain',
];

UNAUDITED_ENDPOINTS.forEach(function(url) {
  // NB: as this evaluates first, it will skip any hooks defined in the rest of
  // the file below, and these calls will all be proxies. If you want to avoid
  // auditing and do other things as well, look to how the _changes feed is
  // handled.
  app.all(url, function(req, res) {
    proxy.web(req, res);
  });
});

app.get('/setup/poll', function(req, res) {
  const p = require('../package.json');
  res.json({
    ready: true,
    handler: 'medic-api',
    version: p.version,
    detail: 'All required services are running normally',
  });
});

app.all('/setup', function(req, res) {
  res.status(503).send('Setup services are not currently available');
});

app.all('/setup/password', function(req, res) {
  res.status(503).send('Setup services are not currently available');
});

app.all('/setup/finish', function(req, res) {
  res.status(200).send('Setup services are not currently available');
});

app.get('/api/info', function(req, res) {
  const p = require('../package.json');
  res.json({ version: p.version });
});

app.get('/api/deploy-info', (req, res) => {
  if (!req.userCtx) {
    return serverUtils.notLoggedIn(req, res);
  }
  res.json(environment.getDeployInfo());
});

app.get('/api/v1/monitoring', deprecation.deprecate('/api/v2/monitoring'), monitoring.getV1);
app.get('/api/v2/monitoring', monitoring.getV2);

app.get('/api/auth/:path', function(req, res) {
  auth.checkUrl(req)
    .then(status => {
      if (status && status >= 400 && status < 500) {
        res.status(403).send('Forbidden');
      } else {
        res.json({ status: status });
      }
    })
    .catch(err => {
      serverUtils.serverError(err, req, res);
    });
});

app.post('/api/v1/upgrade', jsonParser, upgrade.upgrade);
app.post('/api/v1/upgrade/stage', jsonParser, upgrade.stage);
app.post('/api/v1/upgrade/complete', jsonParser, upgrade.complete);

app.post('/api/v1/sms/africastalking/incoming-messages', formParser, africasTalking.incomingMessages);
app.post('/api/v1/sms/africastalking/delivery-reports', formParser, africasTalking.deliveryReports);

app.post('/api/v1/sms/radpidpro/incoming-messages', jsonParser, rapidPro.incomingMessages);

app.get('/api/sms/', (req, res) => res.redirect(301, '/api/sms'));
app.get('/api/sms', smsGateway.get);

app.post('/api/sms/', (req, res) => res.redirect(301, '/api/sms'));
app.postJson('/api/sms', smsGateway.post);

app.get('/api/v2/export/:type', exportData.get);
app.postJson('/api/v2/export/:type', exportData.get);

app.post('/api/v1/records', [jsonParser, formParser], records.v1);
app.post('/api/v2/records', [jsonParser, formParser], records.v2);

app.get('/api/v1/forms/', (req, res) => {
  res.redirect(301, '/api/v1/forms');
});
app.get('/api/v1/forms', forms.list);
app.get('/api/v1/forms/:form', forms.get);
app.post('/api/v1/forms/validate', textParser, forms.validate);

app.get('/api/v1/users', users.get);
app.postJson('/api/v1/users', users.create);
app.postJson('/api/v1/users/:username', users.update);
app.delete('/api/v1/users/:username', users.delete);
app.get('/api/v1/users-info', authorization.getUserSettings, users.info);

app.postJson('/api/v1/places', function(req, res) {
  auth
    .check(req, 'can_create_places')
    .then(() => {
      if (_.isEmpty(req.body)) {
        return serverUtils.emptyJSONBodyError(req, res);
      }
      return places.createPlace(req.body).then(body => res.json(body));
    })
    .catch(err => serverUtils.error(err, req, res));
});

app.postJson('/api/v1/places/:id', function(req, res) {
  auth
    .check(req, 'can_update_places')
    .then(() => {
      if (_.isEmpty(req.body)) {
        return serverUtils.emptyJSONBodyError(req, res);
      }
      return places
        .updatePlace(req.params.id, req.body)
        .then(body => res.json(body));
    })
    .catch(err => serverUtils.error(err, req, res));
});

app.postJson('/api/v1/people', function(req, res) {
  auth
    .check(req, 'can_create_people')
    .then(() => {
      if (_.isEmpty(req.body)) {
        return serverUtils.emptyJSONBodyError(req, res);
      }
      return people.createPerson(req.body).then(body => res.json(body));
    })
    .catch(err => serverUtils.error(err, req, res));
});

app.postJson('/api/v1/bulk-delete', bulkDocs.bulkDelete);

// offline users are not allowed to hydrate documents via the hydrate API
app.get('/api/v1/hydrate', authorization.offlineUserFirewall, jsonQueryParser, hydration.hydrate);
app.post('/api/v1/hydrate', authorization.offlineUserFirewall, jsonParser, jsonQueryParser, hydration.hydrate);

// offline users are not allowed to get contacts by phone
app.get('/api/v1/contacts-by-phone', authorization.offlineUserFirewall, contactsByPhone.request);
app.post('/api/v1/contacts-by-phone', authorization.offlineUserFirewall, jsonParser, contactsByPhone.request);

app.get(`${appPrefix}app_settings/${environment.ddoc}/:path?`, settings.getV0); // deprecated
app.get('/api/v1/settings', settings.get);
app.get('/api/v1/settings/deprecated-transitions', settings.getDeprecatedTransitions);

app.putJson(`${appPrefix}update_settings/${environment.ddoc}`, settings.put); // deprecated
app.putJson('/api/v1/settings', settings.put);

app.get('/api/couch-config-attachments', couchConfigController.getAttachments);

app.get('/purging', authorization.onlineUserPassThrough, purgedDocsController.info);
app.get('/purging/changes', authorization.onlineUserPassThrough, purgedDocsController.getPurgedDocs);
app.get('/purging/checkpoint', authorization.onlineUserPassThrough, purgedDocsController.checkpoint);

app.get('/api/v1/users-doc-count', replicationLimitLogController.get);

// authorization middleware to proxy online users requests directly to CouchDB
// reads offline users `user-settings` and saves it as `req.userCtx`
const onlineUserProxy = _.partial(authorization.onlineUserProxy, proxy);
const onlineUserChangesProxy = _.partial(
  authorization.onlineUserProxy,
  proxyForChanges
);

// DB replication endpoint
const changesHandler = require('./controllers/changes').request;
const changesPath = routePrefix + '_changes(/*)?';

app.get(
  changesPath,
  onlineUserChangesProxy,
  changesHandler
);
app.post(
  changesPath,
  onlineUserChangesProxy,
  jsonParser,
  changesHandler
);

// filter _all_docs requests for offline users
const allDocsHandler = require('./controllers/all-docs').request;
const allDocsPath = routePrefix + '_all_docs(/*)?';

app.get(allDocsPath, onlineUserProxy, jsonQueryParser, allDocsHandler);
app.post(
  allDocsPath,
  onlineUserProxy,
  jsonParser,
  jsonQueryParser,
  allDocsHandler
);

// filter _bulk_get requests for offline users
const bulkGetHandler = require('./controllers/bulk-get').request;
app.post(
  routePrefix + '_bulk_get(/*)?',
  onlineUserProxy,
  jsonParser,
  jsonQueryParser,
  bulkGetHandler
);

// filter _bulk_docs requests for offline users
// this is an audited endpoint: online and filtered offline requests will pass through to the audit route
app.post(
  routePrefix + '_bulk_docs(/*)?',
  jsonParser,
  infodoc.mark,
  authorization.onlineUserPassThrough, // online user requests pass through to the next route
  jsonQueryParser,
  bulkDocs.request,
  authorization.setAuthorized // adds the `authorized` flag to the `req` object, so it passes the firewall
);

// filter db-doc and attachment requests for offline users
// these are audited endpoints: online and allowed offline requests will pass through to the audit route
const dbDocHandler = require('./controllers/db-doc');
const docPath = routePrefix + ':docId/{0,}';
const attachmentPath = routePrefix + ':docId/+:attachmentId*';
const ddocPath = routePrefix + '_design/+:ddocId*';

app.get(
  ddocPath,
  onlineUserProxy,
  jsonQueryParser,
  _.partial(dbDocHandler.requestDdoc, environment.ddoc),
  authorization.setAuthorized // adds the `authorized` flag to the `req` object, so it passes the firewall
);

app.get(
  docPath,
  onlineUserProxy, // online user GET requests are proxied directly to CouchDB
  jsonQueryParser,
  dbDocHandler.request
);
app.post(
  `/+${environment.db}/?`,
  jsonParser,
  infodoc.mark,
  authorization.onlineUserPassThrough, // online user requests pass through to the next route
  jsonQueryParser,
  dbDocHandler.request,
  authorization.setAuthorized // adds the `authorized` flag to the `req` object, so it passes the firewall
);
app.put(
  docPath,
  jsonParser,
  infodoc.mark,
  authorization.onlineUserPassThrough, // online user requests pass through to the next route,
  jsonQueryParser,
  dbDocHandler.request,
  authorization.setAuthorized // adds the `authorized` flag to the `req` object, so it passes the firewall
);
app.delete(
  docPath,
  authorization.onlineUserPassThrough, // online user requests pass through to the next route,
  jsonQueryParser,
  dbDocHandler.request,
  authorization.setAuthorized // adds the `authorized` flag to the `req` object, so it passes the firewall
);
app.all(
  attachmentPath,
  authorization.onlineUserPassThrough, // online user requests pass through to the next route
  jsonQueryParser,
  dbDocHandler.request,
  authorization.setAuthorized // adds the `authorized` flag to the `req` object, so it passes the firewall
);

const metaPathPrefix = `/${environment.db}-user-*-meta/`;

app.all('/+medic-user-*-meta(/*)?', (req, res, next) => {
  if (environment.db !== 'medic') {
    req.url = req.url.replace('/medic-user-', `/${environment.db}-user-`);
  }
  next();
});

// AuthZ for this endpoint should be handled by couchdb
app.get(metaPathPrefix + '_changes', (req, res) => {
  proxyForChanges.web(req, res);
});

// Attempting to create the user's personal meta db
app.put(metaPathPrefix, createUserDb);
// AuthZ for this endpoint should be handled by couchdb, allow offline users to access this directly
app.all(metaPathPrefix + '*', authorization.setAuthorized);

const writeHeaders = function(req, res, headers, redirectHumans) {
  res.oldWriteHead = res.writeHead;
  res.writeHead = function(_statusCode, _headers) {
    // hardcode this so we do not show the basic auth prompt by default
    res.setHeader('WWW-Authenticate', 'Cookie');
    if (headers) {
      headers.forEach(function(header) {
        res.setHeader(header[0], header[1]);
      });
    }
    // for dynamic resources, redirect humans to login page
    if (_statusCode === 401) {
      if (isClientHuman(req)) {
        if (redirectHumans) {
          _statusCode = 302;
          res.setHeader(
            'Location',
            pathPrefix + 'login?redirect=' + encodeURIComponent(req.url)
          );
        }
      } else {
        res.setHeader('WWW-Authenticate', serverUtils.MEDIC_BASIC_AUTH);
      }
    }
    res.oldWriteHead(_statusCode, _headers);
  };
};

// allow POST requests which have been body-parsed to be correctly proxied
const writeParsedBody = (proxyReq, req) => {
  if (req.body) {
    const bodyData = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Type', 'application/json');
    proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
    proxyReq.write(bodyData);
  }
};

const copyProxyHeaders = (proxyRes, res) => {
  if (!res.headersSent) {
    res.statusCode = proxyRes.statusCode;
    if (proxyRes.statusMessage) {
      res.statusMessage = proxyRes.statusMessage;
    }

    _.each(proxyRes.headers, (value, key) => {
      if (value !== undefined) {
        res.setHeader(String(key).trim(), value);
      }
    });
  }
};

/*
A service worker can't have a scope broader than its own location.
To give our service worker control of all resources, create an alias at root.
*/
app.get('/service-worker.js', (req, res) => {
  writeHeaders(req, res, [
    // For users before Chrome 68 https://developers.google.com/web/updates/2018/06/fresher-sw
    ['Cache-Control', 'max-age=0'],
    ['Content-Type', 'application/javascript'],
  ]);

  res.sendFile(path.join(extractedResourceDirectory, 'js/service-worker.js'));
});

/**
 * Set cache control on static resources. Must be hacked in to
 * ensure we set the value first.
 */
proxy.on('proxyReq', function(proxyReq, req, res) {
  if (
    !staticResources.test(req.url) &&
    req.url.indexOf(appPrefix) !== -1
  ) {
    // requesting other application files
    writeHeaders(req, res, [], true);
  } else {
    // everything else
    writeHeaders(req, res);
  }

  writeParsedBody(proxyReq, req);
});

proxyForChanges.on('proxyReq', (proxyReq, req) => {
  writeParsedBody(proxyReq, req);
});

// because these are longpolls, we need to manually flush the CouchDB heartbeats through compression
proxyForChanges.on('proxyRes', (proxyRes, req, res) => {
  copyProxyHeaders(proxyRes, res);

  proxyRes.pipe(res);
  proxyRes.on('data', () => res.flush());
});

/**
 * Make sure requests to these urls sans trailing / are redirected to the
 * correct slashed endpoint to avoid weird bugs
 */
[appPrefix, pathPrefix].forEach(function(url) {
  const urlSansTrailingSlash = url.slice(0, -1);
  app.get(urlSansTrailingSlash, function(req, res) {
    res.redirect(url);
  });
});

// allow offline users to access the app
app.all(appPrefix + '*', authorization.setAuthorized);

// block offline users requests from accessing CouchDB directly, via Proxy
// requests which are authorized (fe: by BulkDocsHandler or DbDocHandler) can pass through
// unauthenticated requests will be redirected to login or given a meaningful error
app.use(authorization.offlineUserFirewall);

const canEdit = function(req, res) {
  auth
    .check(req, 'can_edit')
    .then(ctx => {
      if (!ctx || !ctx.user) {
        serverUtils.serverError('not-authorized', req, res);
        return;
      }
      proxyForAuth.web(req, res);
    })
    .catch(() => {
      serverUtils.serverError('not-authorized', req, res);
    });
};

const editPath = routePrefix + '*';
app.put(editPath, canEdit);
app.post(editPath, canEdit);
app.delete(editPath, canEdit);

app.all('*', function(req, res) {
  proxy.web(req, res);
});

proxy.on('error', function(err, req, res) {
  serverUtils.serverError(JSON.stringify(err), req, res);
});

proxyForAuth.on('error', function(err, req, res) {
  serverUtils.serverError(JSON.stringify(err), req, res);
});

proxyForChanges.on('error', (err, req, res) => {
  serverUtils.serverError(JSON.stringify(err), req, res);
});

proxyForAuth.on('proxyReq', function(proxyReq, req) {
  writeParsedBody(proxyReq, req);
});

// intercept responses from filtered offline endpoints to fill in with forbidden docs stubs
proxyForAuth.on('proxyRes', (proxyRes, req, res) => {
  copyProxyHeaders(proxyRes, res);

  if (res.interceptResponse) {
    let body = Buffer.from('');
    proxyRes.on('data', data => (body = Buffer.concat([body, data])));
    proxyRes.on('end', () => res.interceptResponse(req, res, body.toString()));
  } else {
    proxyRes.pipe(res);
  }
});

proxyForAuth.on('proxyRes', infodoc.update);
proxy.on('proxyRes', infodoc.update);

module.exports = app;
