var request = require('request');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var _ = require('lodash');
var uTorrent = require('./utorrent');
var parseTorrent = require('parse-torrent');
var async = require('async');
var Redis = require('ioredis');
var ms = require('ms');

/**
 * Expose uCluster.
 */
module.exports = uCluster;

function uCluster(servers, options) {

  options = options || { keyPrefix: 'utorrent:' };
  this.servers = [];
  this.redis = new Redis(options);

  var self = this;

  servers.forEach(function(server) {
    server.download_dir = _.isUndefined(server.download_dir) ? '/' : server.download_dir
    var ut = new uTorrent({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      download_dir: server.download_dir
    }, self.redis);
    self.servers.push(ut)
  })

  return this;

};

/**
 * Inherit from 'EventEmitter.prototype'.
 */

util.inherits(uCluster, EventEmitter);

/**
 * Find the server associated to a specific hash
 */
uCluster.prototype.getServerByHash = function(hash, callback) {

  var self = this;
  //Get the server associated to the supplied hash
  this.redis.get(hash, function(err, res) {
    try { 
      var server = self.servers.filter(function(server) {
        return server.host == JSON.parse(res);
      });

      if (_.isEmpty(server)) {
         return callback(null, null);
      }

      if (server.length > 1) {
        callback(null, server[0]);
      } else {
        callback(null, server);
      }

    } catch (e) {
      callback(e);
    }
  });

};

/**
 * Search all servers and find the first with the associated hash
 */
uCluster.prototype.searchServersByHash = function(hash, callback) {

  var self = this;

  var uServer = null;
  //Search all servers for the supplied hash and return if found.
  async.each(this.servers, function(server, cb) {
    server.get(hash, function(err, res) {
      if (res) {
      self.redis.multi().set(hash, JSON.stringify({host: server.host})).expire(hash, ms('5m') / 1000);
        uServer = server;
        cb(200);
      } else {
        cb();
      }
    })
  }, function(err) {
      if (err) {
        if (err === 200) {
          callback(null, uServer);
        } else {
          callback(err, null);
        }
      } else {
        callback(null, null);
      }
  });

};



/**
 * Get the lowest loaded server, new torrents are always added to the server with lowest load
 */
uCluster.prototype.getLowestLoaded = function(callback) {

  var serverCounts = [];
  async.each(this.servers, function(server, cb) {
    server.getCount(function(err, count) {
      serverCounts.push({
        server: server,
        count: count
      });
      cb(err);
    })
  }, function(err) {

      if (err) {
        return callback(err);
      }

      if (_.isEmpty(serverCounts)) {
        return callback('No servers were found when attempting to get counts.');
      }
    
      var ut = _.sortBy(serverCounts, 'count')[0].server;
      callback(null, ut);
  });

};

/**
 * Add new torrent to the lowest loaded server
 */
uCluster.prototype.add = function(torrent_url, callback) {  

  var self = this;

  parseTorrent.remote(torrent_url, function (err, parsedTorrent) {

    if (err) {
      return callback({
        torrent_url: torrent_url,
        reason: err.message,
        parse_torrent: true
      });
    }

    var hash = parsedTorrent.infoHash;

  self.getServer(hash, function(err, server) {
    
    if (server) {
      return server.resume(hash, callback);
    }
    
    self.getLowestLoaded(function(err, server) {
       if (err) {
         return callback(err);
       }
       if (!server) {
         return callback(null, null);
       }
       server.add(torrent_url, hash, function(err, uEvent, torrent) {
      
         if (err) {
           return callback(err); 
         }
        
         self.redis.multi().set(uEvent.hash, JSON.stringify({host: server.host})).expire(uEvent.hash, ms('5m') / 1000);
         callback(err, uEvent, torrent);
    
       });
    });
    
  });

  });

  return this;

};


uCluster.prototype.remove = function(hash, callback) {
  
  var self = this;

  this.getServer(hash, function(err, server) {

    if (err) {
      return callback(err);
    }

    if (!server) {
      return callback(null, null);
    }

    self.redis.del(hash);
    server.remove(hash, callback);

  });

}

uCluster.prototype.removeData = function(hash, callback) {
  
  var self = this;

  this.getServer(hash, function(err, server) {

    if (err) {
      return callback(err);
    }

    if (!server) {
      return callback(null, null);
    }

    self.redis.del(hash);
    server.removeData(hash, callback);

  });

}

uCluster.prototype.getServer = function(hash, callback) {

  var self = this;

  async.waterfall([
    function(cb) {
      self.getServerByHash(hash, cb);
    },
    function(server, cb) {
      if (server) {
        return cb(null, server);
      }
      self.searchServersByHash(hash, cb);
    }
  ], callback);

};


/**
 * Find in cluster and get the torrent object for the associated hash
 */
uCluster.prototype.get = function(hash, callback) { 

  this.getServer(hash, function(err, server) {

    if (err) {
      return callback(err);
    }

    if (!server) {
      return callback(null, null);
    }

    server.get(hash, callback);

  });

}