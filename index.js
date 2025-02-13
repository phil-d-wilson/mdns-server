
const dgram = require('dgram');
const packet = require('dns-packet');
const events = require('events');
const os = require('os');

const MDNS_IPV4 = '224.0.0.251';
const MDNS_IPV6 = 'FF02::FB';
const MDNS_PORT = 5353;

const ErrorMessages = {
  NO_INTERFACES: 'No available interfaces.'
};

module.exports = function (options) {
  options = options || {};
  var emitter = new events.EventEmitter();
  var mDNS = {
    config: {
      reuseAddr: typeof options.reuseAddr === 'undefined' ? true : options.reuseAddr,
      interfaces: options.interfaces || options.interface || null,
      ttl: options.ttl || 255,
      loopback: typeof options.loopback === 'undefined' ? true : options.loopback,
      noInit: !!options.noInit,
      srcPort: options.srcPort || 0
    },
    destroyed: false,
    interfaces: [],

    init: function () {
      // build the list of network interfaces
      if (!mDNS.config.interfaces) {
        mDNS.config.interfaces = mDNS.getInterfaces();
      } else if (mDNS.interfacesIsStrings(mDNS.config.interfaces)) {
        mDNS.config.interfaces = mDNS.interfacesFromStrings(mDNS.config.interfaces);
      }
      if (!mDNS.config.interfaces || !mDNS.config.interfaces.length) {
        emitter.emit('error', new Error(ErrorMessages.NO_INTERFACES));
      }

      // create sockets on interfaces
      mDNS.interfaces = mDNS.config.interfaces.slice();
      mDNS.createSockets()
        .then(() => {
          emitter.emit('ready');
        })
        .catch((err) => {
          emitter.emit('error', err);
        });
    },

    // create socket for each interface
    createSockets: function () {
      return new Promise((resolve, reject) => {
        var processInterface = function (i) {
          // check if complete
          if (i >= mDNS.interfaces.length) {
            if (mDNS.countListeningSockets()) {
              resolve();
            } else {
              reject(new Error('No sockets created.'));
            }
          } else {
            // process this interface
            mDNS.createNewSockets(mDNS.interfaces[i])
              .then((listening) => {
                if (listening) {
                  mDNS.interfaces[i].listening = true;
                }
                // process next interface
                processInterface(i + 1);
              });
          }
        };
        // start processing
        processInterface(0);
      });
    },

    // create new socket for an interface
    createNewSockets: function (iface) {
      return new Promise((resolve, reject) => {
        mDNS.createSendSocket(iface)
          .then(function () {
            return mDNS.createReceiveSocket(iface);
          })
          .then(function () {
            resolve(true);
          })
          .catch(function (err) {
            iface.socketRecv = null;
            iface.socketSend = null;
            // socket failure, continue to next interface
            resolve(false);
            return err; // really only doing this to pass semistandard
          });
      });
    },

    createReceiveSocket: function (iface) {
      return new Promise((resolve, reject) => {
        iface.bindStatus = {
          listening: false,
          catchAll: false
        };

        mDNS.getReceiveSocket(iface)
          .then(success => {
            if (!success) {
            // try again with catch-all address
              iface.bindStatus.catchAll = true;
            }
            return success || mDNS.getReceiveSocket(iface);
          })
          .then(success => {
            if (!success) {
              reject(new Error('Failed to get receive socket'));
            } else {
              resolve();
            }
          })
          .catch(err => { reject(err); });
      });
    },

    // get a receive socket for the given interface
    getReceiveSocket: function (iface) {
      return new Promise((resolve, reject) => {
        iface.socketRecv = dgram.createSocket({
          type: (iface.family === 'IPv4' ? 'udp4' : 'udp6'),
          reuseAddr: mDNS.config.reuseAddr
        })
          .on('error', (err) => {
            if (iface.bindStatus.listening) {
              mDNS.socketError(err);
            } else {
              iface.socketRecv.close();
              resolve(false);
            }
          })
          .on('listening', () => {
            iface.bindStatus.listening = true;
            iface.socketRecv.setMulticastTTL(mDNS.config.ttl);
            iface.socketRecv.setMulticastLoopback(mDNS.config.loopback);
            try {
              iface.socketRecv.addMembership(
                (iface.family === 'IPv4' ? MDNS_IPV4 : MDNS_IPV6),
                iface.bindStatus.address + (iface.family === 'IPv4' ? '' : '%' + iface.name)
              );
              resolve(true);
            } catch (e) {
              iface.socketRecv.close();
              iface.bindStatus.listening = false;
              resolve(false);
            }
          })
          .on('message', (msg, rinfo) => {
          // include interface name so we know where the message came in
            rinfo.interface = iface.name;
            mDNS.socketOnMessage(msg, rinfo);
          });

        if (iface.bindStatus.catchAll) {
          iface.bindStatus.address = (os.platform() === 'win32' ? iface.address : (iface.family === 'IPv4' ? '0.0.0.0': '::'));
        } else {
          iface.bindStatus.address = (iface.family === 'IPv4' ? MDNS_IPV4 : MDNS_IPV6);
        }
        iface.socketRecv.bind(MDNS_PORT, iface.bindStatus.address + (iface.family === 'IPv4' ? '' : '%' + iface.name));
      });
    },

    createSendSocket: function (iface) {
      return new Promise((resolve, reject) => {
        iface.socketSend = dgram.createSocket({
          type: (iface.family === 'IPv4' ? 'udp4' : 'udp6'),
          reuseAddr: mDNS.config.reuseAddr
        })
          .once('error', (err) => {
            reject(new Error(err.message));
          })
          .on('error', mDNS.socketError)
          .on('listening', () => {
            iface.socketSend.setMulticastTTL(mDNS.config.ttl);
            resolve();
          })
          .on('message', (msg, rinfo) => {
          // include interface name so we know where the message came in
            rinfo.interface = iface.name;
            mDNS.socketOnMessage(msg, rinfo);
          })
          .bind(mDNS.config.srcPort, iface.address + (iface.family === 'IPv4' ? '' : '%' + iface.name));
      });
    },

    // process socket error
    socketError: function (err) {
      if (err.code === 'EACCES' || err.code === 'EADDRINUSE' || err.code === 'EADDRNOTAVAIL') {
        emitter.emit('error', err);
      } else {
        emitter.emit('warning', err);
      }
    },

    // event handler for incoming mDNS packets
    socketOnMessage: function (message, rinfo) {
      try {
        message = packet.decode(message);
      } catch (err) {
        emitter.emit('warning', err);
        return;
      }

      emitter.emit('packet', message, rinfo);
      switch (message.type) {
        case 'query':
          emitter.emit('query', message, rinfo);
          break;

        case 'response':
          emitter.emit('response', message, rinfo);
          break;
      }
    },

    // count the number of interface sockets that are listening
    countListeningSockets: function () {
      var ic = 0;
      mDNS.interfaces.forEach((iface) => {
        ic += iface.listening ? 1 : 0;
      });
      return ic;
    },

    // discover all non-internal network interfaces
    getInterfaces: function () {
      var interfaces = [];
      var names = [];
      var osInterfaces = os.networkInterfaces();
      Object.keys(osInterfaces).forEach(function (iface) {
        if (names.includes(iface)) {
          return;
        }
        names.push(iface);
        osInterfaces[iface].forEach(function (assignment) {
          if (
            assignment.internal ||
            (assignment.family !== 'IPv4' && assignment.family !== 'IPv6') ||
            /^(2002|2001):/ig.exec(assignment.address)
          ) {
            // unsupported family, internal interface, or special IPv6 prefix
            return;
          }
          interfaces.push({ name: iface, address: assignment.address, family: assignment.family });
        });
      });
      return interfaces;
    },

    // check to see if the provided interfaces is made up of strings
    interfacesIsStrings: function (interfaces) {
      return (
        typeof mDNS.config.interfaces === 'string' ||
        (
          Array.isArray(mDNS.config.interfaces) &&
          mDNS.config.interfaces.length &&
          typeof mDNS.config.interfaces[0] === 'string'
        )
      );
    },

    // convert interfaces specified by address string or name string into os interface objects
    interfacesFromStrings: function (strings) {
      strings = Array.isArray(strings) ? strings : [strings];
      var interfaces = [];
      var osInterfaces = mDNS.getInterfaces();
      var ii;
      strings.forEach((str) => {
        for (ii = 0; ii < osInterfaces.length; ii++) {
          if (str.toUpperCase() === osInterfaces[ii].address.toUpperCase() || str === osInterfaces[ii].name) {
            // include interface that was specified by address or name
            interfaces.push(osInterfaces[ii]);
          }
        }
      });
      return interfaces;
    },

    // find the interfaces that match the provided rinfo
    getInterfaceMatches: function (rinfo) {
      var interfaces = [];
      mDNS.interfaces.forEach((iface) => {
        if (!rinfo.interface || (rinfo.interface === iface.name && rinfo.family === iface.family)) {
          interfaces.push(iface);
        }
      });
      return interfaces;
    },

    // no operation
    noop: function () {},

    // send an mDNS packet
    send: function (value, rinfo, cb) {
      if (typeof rinfo === 'function') {
        return mDNS.send(value, null, rinfo);
      }
      if (!cb) {
        cb = mDNS.noop;
      }
      if (mDNS.destroyed) {
        return cb();
      }

      // determine which intefaces to use for send
      var interfaces;
      if (!rinfo) {
        interfaces = mDNS.interfaces;
      } else {
        interfaces = mDNS.getInterfaceMatches(rinfo);
      }

      // send message on each interface
      var message = packet.encode(value);
      var processInterface = function (ii) {
        if (ii >= interfaces.length || mDNS.destroyed) {
          return cb();
        } else if (interfaces[ii].socketSend) {
          interfaces[ii].socketSend.send(
            message,
            0,
            message.length,
            MDNS_PORT,
            (interfaces[ii].family === 'IPv4' ? MDNS_IPV4 : MDNS_IPV6 + '%' + interfaces[ii].name),
            function () {
              processInterface(ii + 1);
            }
          );
        } else {
          // interface did not have socket
          processInterface(ii + 1);
        }
      };
      processInterface(0);
    },

    // send an mDNS query
    query: function (q, type, rinfo, cb) {
      if (typeof type === 'function') {
        return mDNS.query(q, null, null, type);
      }
      if (typeof type === 'object' && type && type.port) {
        return mDNS.query(q, null, type, rinfo);
      }
      if (typeof rinfo === 'function') {
        return mDNS.query(q, type, null, rinfo);
      }
      if (!cb) {
        cb = mDNS.noop;
      }

      if (typeof q === 'string') {
        q = [{name: q, type: type || 'ANY'}];
      }
      if (Array.isArray(q)) {
        q = {type: 'query', questions: q};
      }

      q.type = 'query';
      mDNS.send(q, rinfo, cb);
    },

    // send an mDNS response
    respond: function (res, rinfo, cb) {
      if (Array.isArray(res)) {
        res = {answers: res};
      }
      res.type = 'response';
      mDNS.send(res, rinfo, cb);
    },

    // destroy the multicast server
    destroy: function (cb) {
      if (!cb) {
        cb = mDNS.noop;
      }
      if (mDNS.destroyed) {
        return process.nextTick(cb);
      }
      mDNS.destroyed = true;
      var processInterface = function (i) {
        if (i >= mDNS.interfaces.length) {
          emitter.emit('destroyed');
          cb();
        } else {
          if (mDNS.interfaces[i].socketSend) {
            mDNS.interfaces[i].socketSend.close();
          }
          if (mDNS.interfaces[i].socketRecv) {
            mDNS.interfaces[i].socketRecv.close();
          }
          processInterface(i + 1);
        }
      };
      processInterface(0);
    }

  };

  if (!mDNS.config.noInit) {
    mDNS.init();
  }

  // expose mDNS methods
  emitter.initServer = mDNS.init;
  emitter.query = mDNS.query;
  emitter.respond = mDNS.respond;
  emitter.destroy = mDNS.destroy;
  emitter.getInterfaces = mDNS.getInterfaces;
  emitter.errorMessages = mDNS.errorMessages;
  return emitter;
};

module.exports.ErrorMessages = ErrorMessages;
