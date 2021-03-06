/*
 * hook.js: Core hook object responsible for managing dnode-based IPC.
 *
 * (C) 2011 Nodejitsu Inc.
 * MIT LICENCE
 *
 */

var dnode = require('dnode'),
    util = require('util'),
    colors = require('colors'),
    npm = require('./npm-api'),
    dns = require('dns'),
    pkginfo = require('pkginfo'),
    semver = require('semver'),
    EventEmitter = require('eventemitter2').EventEmitter2;

var DELIMITER = '::';

//
// TODO: Switch transports require to lazy loaded based on,
// /transports/ directory files
//
var _transports = {
  "couchdb": require('./transports/couchdb')
};

//
// ### function Hook (options)
// #### @options {Object} Options for this instance.
// Constructor function for the Hook object responsible for managing
// dnode based IPC.
//
var Hook = exports.Hook = function (options) {
  var self = this;

  //
  // Expose pkginfo to the hook
  //
  self.pkginfo = pkginfo.read('.').package;

  EventEmitter.call(this, { delimiter: DELIMITER, wildcard: true });
  options = options || {};

  // From @stolsma -
  //
  // Always get configuration from file or redis store but not when requested
  //
  // TODO: Maybe the caller of this constructor can decide better if 
  // config needs to be called and call config itself...
  // This will be an API change!!!!
  //
  if (!options.noConfig) {
    this.config(options);
  }

  //
  // Setup some intelligent defaults.
  //
  this.id        = 0;
  this._names    = {};
  this.defaults  = {};
  this.children  = {};
  this.listening = false;
  this.connected = false;

  //
  // The covention of self.foo = self.foo || options.foo,
  // is being used so other classes can extend the Hook class
  //
  this.name  = this.name  || options.name  || options['hook-name'] || 'no-name';
  this.type  = this.type  || options.type  || options['hook-type'] || 'hook';
  this.debug = this.debug || options.debug || false;

  //
  // All servers and clients will listen and connect port 5000 by default
  //
  this.defaults['hook-port']   = options['hook-port']   || 5000;
  this.defaults['hook-host']   = options['hook-host']   || '127.0.0.1';
  this.defaults['hook-socket'] = options['hook-socket'] || null;

  this.npm = npm;

  //
  // Assign message transports for this hook
  //
  this.transports = this.transports || options.transports || [];

  //
  // TODO: Move all event mapping to eventMap module
  //
  this.on('*::getEvents', function () {
    self.emit('gotEvents', self.getEvents());
    //
    // TODO: Add callback stuff here
    //
  });

  this.on('*::install', function (hook, callback) {
    self.emit('npm::installing', hook);
    npm.install(hook, function (err, result) {
      if (err) {
        return self.emit('npm::install::error', err);
      }
      self.emit('npm::installed', result);
    });
  });

  //
  // If we have been passed in an eventMap,
  // map each event to the Hook
  //
  if (typeof options.eventMap === 'object') {
    self.mapEvents(options.eventMap);
  }

  self.on("*::query", self.query);
  self.on("query", self.query);

  //
  //  Remark: The `hook::started` event is fired when the dnode server is up,
  //  and waiting for connections. During `hook::started` we will determine if there is,
  //  any startup logic required before we fire `hook::ready`
  //
  self.on('hook::started', function () {

    //
    //  TODO: Add some startup logic here,
    //  like checking for hooks to spawn up
    //
    if (self.hooks && self.hooks.length) {
      self.once('children::ready', function () {
        self.emit('hook::ready');
      });
      self.spawn(self.hooks);
    } else {
      self.emit('hook::ready');
    }

  });

};

//
// Inherit from `EventEmitter2`.
//
util.inherits(Hook, EventEmitter);


//
//  Require additional modules to extend the Hook's functionality
//
//  Remark: It's possible in future versions we can have more control,
//  over which modules are loaded to directly extend hook.io's core
//
//
Hook.prototype.config    = require('./config').config;
Hook.prototype.spawn     = require('./spawn').spawn;
Hook.prototype.log       = require('./log').log;
Hook.prototype.query     = require('./query').query;


//
// ### function emit (event, data, local)
// #### @event {string} Event name to emit / broadcast
// #### @data {**} Data to associate with the event
// #### @broadcast {boolean} Value indicating if this event is local (i.e. should not be broadcast)
// Calls of the listeners on `event` for this instance and also broadcasts
// it to the parent (i.e. `this.remote`) if it exists and `local` is not set.  
//
// TODO: Support more than one data argument in `.emit()`
// TODO: Move Hook.emit to separate module
//
Hook.prototype.emit = function (event, data, callback) {

  var self = this;
  //
  // Remark: `newListener` is reserved by EE and EE2,
  // if we encounter it, just fire EventEmitter.emit as normal,
  // with no arguments modifications
  //
  if (['newListener', 'removeListener', 'remoteAllListeners'].indexOf(event) !== -1) {
    if(self.remote) {
      // If a client's subscriptions change, update the server.
      self.remote.message(event, data, callback);
    } else if(self.server) {
      // We're on the server, update events right away.
      self._addOrRemoveEvent(self.name, event, data);
    }
    
    return EventEmitter.prototype.emit.apply(this, arguments);
  }

  //
  // Log all emitted events
  //
  self.log(this, event, data);

  //
  // Curry arguments to support multiple styles,
  // of callback passing.
  //
  if (typeof data === 'function') {
    callback = data;
    data = null;
  }

  if (typeof callback !== 'function') {
   //
   // Remark: If no callback has been sent,
   // attempt to auto-create a callback that emits,
   // based on the following convention:
   //
   //
   //  Since no callback function was detected, we are going to create a callback,
   //  that emits back the event name appended with either:
   //
   //         `event::result`  - Emitted when callback is fired without error
   //              OR
   //         `event::error`   - Emitted when callback is fired with an error
   //
   callback = function (err, result) {
     if (err) {
       //
       // Remark: In addition to firing the `::error` event,
       // we set a property `ctx` of the error, which
       // contains the original data sent to the hook that caused,
       // the error in the first place. This is useful for debugging.
       //
       err.ctx = data;
       return self.emit(event + '::error', err);
     }
     result.ctx = data;
     return self.emit(event + '::result', result);
   };
  }

  //
  // Remark: Experimental mutli-transport event brokers
  //
  this.transports.forEach(function (transport) {
    _transports[transport.type].message(transport.options, this.name + DELIMITER + event, data, callback);
  });

  if (self.remote) {
    //
    // If this call to emit has not been forced local and this instance has a
    // remote (i.e. parent) connection, then broadcast event back to the remote
    //

    //
    // Remark: Default dnode transport
    //
    this.remote.message(this.name + DELIMITER + event, data, callback);
  }

  //
  // Remark: After we process any hook.io messaging,
  // we still need to call the event, so fire it
  //
  return EventEmitter.prototype.emit.apply(this, [event, data, callback]);
};

//
// ### function start (options, callback) 
// #### @options {Object} Options to use when starting this hook.
// #### @callback {function} Continuation to respond to when complete
// Attempts to spawn the hook server for this instance. If a server already
// exists for those `options` then attempt to connect to that server.
//
Hook.prototype.start = function (options, callback) {  
  var self = this;

  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }

  //
  // Remark: (indexzero) `.start()` should do more lookup
  // table auto-discovery before calling `.listen()` but
  // that's a work in progress
  //
  this.listen(options, function (err) {
    if (err && err.code === 'EADDRINUSE') {
      return self.connect(options, callback);
    }
    if (callback) {
      callback.apply(this, arguments);
    }
  });
};

//
// ### function stop (callback) 
// #### @callback {function} Continuation to respond to when complete
// Attempts to stop the hook from being either a server or client
//
Hook.prototype.stop = function (callback) {  
  var self = this;
  callback = callback || function() {};
  
  if (self.server) {
    self.server.on('close', function(err) {
      delete self.server;
      self.listening = false;
      callback(err);
    });
    self.server.end();
    self.server.close();
  }
  else if(self.conn) {
    self.conn.once('end', function(err) {
      delete self.conn;
      self.connected = false;
      callback(err);
    });
    self.conn.end();
  }
  else {
    callback(new Error('Nothing to stop'));
  }
};

//
// ### function kill (options, callback)
// #### @options {String} The child hook name which is to be killed
// #### @callback {function} Continuation to respond to when complete
// Kills a hook, Frees up cpu power.
//
Hook.prototype.kill = function(options, callback) {
  var self = this;
  callback = callback || function() {};

  if (options && typeof options=='string') {
    self.children[options].monitor.stop();
  }
  else {
    if (self.server) {
      callback(new Error('Cannot kill server'));
    }
    else if(self.conn) {
      self.stop();
      self.removeAllListeners();
      self.emit = function() {};
    }
    else {
      callback(new Error('Nothing to kill'));
    }
  }
}

//
// ### function listen (options, callback) 
// #### @options {Object} Options to use when listening for this hook server.
// #### @callback {function} Continuation to respond to when complete
// Attempts to spawn the hook server for this instance. 
//
Hook.prototype.listen = function (options, callback) { 
  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }
  
  options = options || {};
  
  this.listening    = true;
  this['hook-port'] = options['hook-port'] || this.defaults['hook-port'];
  this['hook-host'] = options['hook-host'] || this.defaults['hook-host'];
  
  if (options.server) {
    this['hook-port'] = options.server;
  }
  
  var self = this;

  //registers the server in the register
  self.toIPs(self['hook-host'], function onResolve (err, hosts) {
    
    if (err) {
      if (callback) return callback(err);
      return self.emit('error::resolve', err);
    }

    var host = hosts[0]; // TODO handle a list of host ?

    // Registers itself in the hook registry using an IP for quick resolution
    self._names[self.name] = {
      name: self.name,
      type: self.type,
      remote: {
        port: self['hook-port'],
        host: host
      },
      events: {}
    };
    
    self._addOrRemoveEvent = function _addOrRemoveEvent(clientName, event, data) {
      var events = self._names[clientName].events;
      switch(event) {
        case 'newListener':
          events[data] = (events[data]||0)+1;
          return true;
        case 'removeListener':
          if(events[data] && --events[data] <= 0) {
            delete events[data];
          }
          return true;
        case 'removeAllListeners':
          delete events[data];
          return true;
      }
      return false;
    };
      
    self._registerEvents = function(clientName, events) {
      events.forEach(function(event) {
        self._addOrRemoveEvent(clientName, 'newListener', event);
      });
    };
    
    self.server = dnode(function (client, conn) {
      //removes the hook from the register
      conn.on('end', function () {
        for (name in self._names) {
          if (self._names[name].session === conn.id) {
            self.emit('hook::disconnected', name);
            delete self._names[name];
            break;
          }
        }
      });

      //TODO: Version checking
      this.report = function (hook, cb) {
        var name   = hook.name,
            type   = hook.type,
            events = hook.events;

        //
        // ### function checkName (name, type, id)
        // #### @name {String} Name of hook to check
        // Recurisively checks hook's name until it
        // finds an available name for hook.
        //
        function checkName (name, id) {

          var _name;

          if (typeof id !== 'undefined') {
            _name = name + '-' + id;
            id++;
          } else {
            id = 0;
            _name = name;
          }

          if (Object.keys(self._names).indexOf(_name) === -1 && self.name !== _name) {
            self._names[_name] = {name: _name};
            return _name;
          } 

          return checkName(name, id);
        }
        
        //
        // Update the name on the client accordingly
        //
        client.name = checkName(name);
        var reporter = self._names[client.name];
        reporter.type = type;
        reporter.session = conn.id;//self.server.proto.sessions[conn.id];
        reporter.remote = {
          port: self.server.proto.sessions[conn.id].stream.remotePort,
          host: self.server.proto.sessions[conn.id].stream.remoteAddress
        };
        
        reporter.events = {};
        self._registerEvents(client.name, events);

        client.type = type;
        //self.emit('client::connected', client.name);
        cb(client.name, null, self.pkginfo);
      };

      this.message = function (event, data, callback) {
        // Handle registry events before emitting again, we don't have access to the client there.
        if(self._addOrRemoveEvent(client.name, event, data)) {
          return;
        }

        self.emit(event, data, callback);
      };

      this.hasEvent = function (parts, remote, callback) {
        callback(null, self.hasEvent.call(self, parts, remote));
      };
      
      //
      // On incoming events to the server,
      // send those events as messages to all clients
      //
      self.onAny(function (data, callback) {
        var parts = this.event.split(DELIMITER),
        event = !self.remote ? [this.event].join(DELIMITER): this.event;
        //
        // Only broadcast if the client has a message function, if
        // the event was not broadcast by the client itself (e.g. no circular transmissions)
        //
        if (client.message && (parts[0] !== client.name)) {

          //
          // Remark: If this was a local event, append the hook name,
          // to the event before broadcasting
          //
          if (parts.length === 1) {
            event = self.name + DELIMITER + event;
          }

          //
          //  Remark: The current approach for minimizing excess messaging is,
          //  to send a message to every client first, to determine if the actual,
          //  message should get sent.
          //
          //
          //  TODO: This is a good start, but ultimately we need to reduce the,
          //  total amount of network hops ( period ). We need to store the available event
          //  table in memory, and then intelligently know when to update it.
          //
          //  In most cases, we can just store this on Hook connection, and never update it
          //

          //
          // Remark: Before sending any message, request client for registered events
          // and send message with data only if the client is interrested in this event
          client.hasEvent(parts, callback, function (err, send) {
            if (!send) {
              //
              // Remark: We may want to do something with this event.
              //
              //         self.emit('hook::noevent', event);
              if (self.debug && !self.quiet) {
                //self.log(self.name, event, data)
              }
              return;
            }

            self.transports.forEach(function (transport) {
              _transports[transport.type].message(transport.options, event, data, callback);
            });

            client.message(event, data, callback);

          });
        }
      });
    });

    self.server.on('error', function (err) {
      if (err) {
        if (err.code == 'EADDRINUSE') {
          self.emit('error::bind', self['hook-port']);
          delete self.server; //not useful anymore, saves memory and trouble finding server
        } else {
          self.emit('error::unknown', err);
        }
      }
      
      if (callback) {
        callback.apply(null, arguments);
      }  
    });
    
    self.server.on('connection', function (conn) {
      self.emit('connection::open', conn);
    });
    
    self.server.on('ready', function () {
      self._registerEvents(self.name, self.getStringEvents());
      
      self.emit('hook::listening', self['hook-port']);
      self.emit('hook::started', self['hook-port']);
      
      if (callback) {
        callback();
      }
    });

    //
    // Remark: Hook discovery could be improved, but needs the semantic
    // and cardinality to be better defined.
    //
    try {
      self.server.listen(self['hook-port']);
    }
    catch (ex) {
      if (callback) {
        return callback(ex);
      }
      
      self.emit('error', ex);
    }
  });
};

//
// ### function connect (options, callback) 
// #### @options {Object} Options to use when starting this hook.
// #### @callback {function} Continuation to respond to when complete
// Attempt to connect to a hook server using the specified `options`.
//
Hook.prototype.connect = function (options, callback) {
  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }
  
  options = options || {};

  this['hook-port'] = options['hook-port'] || this['hook-port'] || this.defaults['hook-port'];
  this['hook-host'] = options['hook-host'] || this['hook-host'] || this.defaults['hook-host'];

  var self = this, 
      client;

  client = dnode({
    message: function (event, data, callback) {
      self.emit(event, data, callback);
    },
    hasEvent: function (parts, remote, callback) {
      callback(null, self.hasEvent.call(self, parts, remote));
    }
  });

  //
  // Remark: Create dnode connection options based 
  // on (this) Hook configuration
  //
  var dnodeOptions = this._dnodeOptions();

  client.connect(dnodeOptions, function (remote, conn) {
    self.conn      = conn;
    self.remote    = remote;
    self.connected = true;

    conn.on('end', function () {
      self.emit('connection::end', self.name);
    });

    // Alternately:
    // {
    //    name: self.name,
    //    type: self.type
    // }

    var reportedData = {
      "name"    : self.name,
      "type"    : self.type,
      "pkginfo" : self.pkginfo,
      "events"  : self.getStringEvents()
    };

    remote.report(reportedData,  function (newName, newID, pkginfo) {
      self.name = newName;
      self.id   = newID;

      //
      // ### function checkVersion (pkginfo)
      // #### @pkginfo {Object} pkginfo of hook to check
      // Checks to make sure that the connecting hook
      // is the same version.
      //
      function checkVersion (pkginfo) {

        if (semver.neq(pkginfo.version, self.pkginfo.version)) {
          throw new Error("remote.version="+pkginfo.version+" !== self.pkginfo.version="+self.pkginfo.version);
        };

      }

      checkVersion(pkginfo);

      self.emit('hook::connected', self['hook-port']);
      self.emit('hook::started', self['hook-port']);
      
      if (callback) {
        callback();
      }
    });
  });
};


Hook.prototype.getEvents = function () {
  return this.listenerTree;
};

// ### function getStringEvents () 
// #### @return {Array} Array of strings representing each listened event.
// Rebuild a list of all the listened events under their string form factor.
//
Hook.prototype.getStringEvents = function () {
  function getStringEvents(node, paths, currentPath) {
    if(typeof node !== 'object') return;
    
    Object.keys(node).forEach(function(child) {
      if(child === '_listeners') return paths.push(currentPath.join(DELIMITER));
      getStringEvents(node[child], paths, currentPath.concat(child));
    });
    
    return paths;
  }

  return getStringEvents(this.listenerTree, [], [], []);
};


Hook.prototype.mapEvents = function (eventMap) {

  var self = this;

  //
  // Iterate through each method and map it to the Hook
  //
  Object.keys(eventMap).forEach(function (event) {
    self.on(event, eventMap[event]);
  });

};

Hook.prototype.hasEvent = function (parts, remote) {
 if (typeof parts !== 'string' && !(parts instanceof Array)) {
   return false;
 }
 return this.listeners(parts);
};

Hook.prototype.off = function(type, listener) {
  EventEmitter.prototype.off.apply(this, arguments);
  this.emit('removeListener', type, listener);
};

Hook.prototype.removeAllListeners = function(type) {
  EventEmitter.prototype.removeAllListeners.apply(this, arguments);
  this.emit('remoteAllListeners', type);
};

//
// ### @private function _cliOptions (options)
// #### @options {Object} Object to serialize into command-line arguments.
// Serializes the specified `options` into a space delimited, double-dash `--`
// set of command-line arguments.
//
//    {
//      host: '127.0.0.1',
//      port: 5010,
//      name: 'some-hook-name',
//      type: 'type-of-hook',
//      beep: 'boop'
//    }
//
//    --hook-host 127.0.0.1 --hook-port 5010 --hook-name some-hook-name --hook-type type-of-hook --beep boop
//
Hook.prototype._cliOptions = function (options) {
  var cli = [];
  
  //
  // TODO: Refactor 'reserved_cli' and module scoped 'reserved' into Protoype variable with nested namespaces
  //
  var reserved_cli = ['port', 'host', 'name', 'type'];

  Object.keys(options).forEach(function (key) {

    var value = options[key];

    if (typeof value === 'object') {
      value = JSON.stringify(value);
    }

    //
    // TODO: Some type inspection to ensure that only
    // literal values are accepted here.
    //
    if (reserved_cli.indexOf(key) === -1) {
      cli.push('--' + key, value);
    } else {
      cli.push('--hook-' + key, value);
    }
  });

  return cli;
};

//
// ### @private function _dnodeOptions ()
// Returns an Object literal for this instance to be passed
// to various dnode methods
//
Hook.prototype._dnodeOptions = function () {
  return {
    port:        this['hook-port'],
    path:        this.socket,
    key:         this.key,
    block:       this.block,
    reconnect:   this.reconnect
  };
};

function isIP(text) {
  var ipRegexp = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))|((([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){6}:[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){5}:([0-9A-Fa-f]{1,4}:)?[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){4}:([0-9A-Fa-f]{1,4}:){0,2}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){3}:([0-9A-Fa-f]{1,4}:){0,3}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){2}:([0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){6}((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|(([0-9A-Fa-f]{1,4}:){0,5}:((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|(::([0-9A-Fa-f]{1,4}:){0,5}((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|([0-9A-Fa-f]{1,4}::([0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})|(::([0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){1,7}:))$/;
  
  return ipRegexp.test(text);
}

Hook.prototype.toIPs = function (host, callback) {
  if (!isIP(host)) {
    dns.resolve(host, function onResolve(err, hosts) {
      if (err)
        callback(err);
      else if (! (hosts.length) > 0)
        callback(new Error("Received invalid host list :"+ hosts));
      else
        callback(null, hosts);
    });
  }
  else
    callback(null, [host]);
};
