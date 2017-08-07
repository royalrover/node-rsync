//
// 算法介绍: https://rsync.samba.org/tech_report/
//
'use strict';

var fs = require('fs')
  , util = require('util')
  , hash = require('./hash')
  , EventEmitter = require('events').EventEmitter;

// 创建hashtable，其中key为 Adler-32和的 弱16bit哈希值，降低冲突概率
function createHashtable(checksums) {
    // 首先解析checksums值
    checksums = checksums.split('$\r\n');

    var hashtable = {}
      , len = checksums.length
      , i = 0;
          
    for (; i < len; i++) {
        if(checksums[i]){
            let checksum = checksums[i]
            , frags = checksum.split('\r\n') // '$1\r\n0\r\n$8\r\n32112640\r\n$32\r\n187ef4436122d1cc2f40dc2b92f0eba0\r\n'
            , weak16 = hash.weak16(+frags[3]); // frags = ['$1',0,'$8','32112640','$32','187ef4436122d1cc2f40dc2b92f0eba0','']
            if (hashtable[weak16]) { 
                hashtable[weak16].push({
                    index: +frags[1], // 文件块的索引
                    weak: +frags[3],
                    strong: frags[5]
                });
            } else {
                hashtable[weak16] = [{
                    index: +frags[1],
                    weak: +frags[3],
                    strong: frags[5]
                }];
            }
        }
        
    }
    return hashtable;
}

// 从客户端修改的文件开始，按窗口大小做“强弱摘要”判断，此后每字节往后移动窗口继续做判断
function roll(data, checksums, chunkSize) {  
    var results = []
      , hashtable = createHashtable(checksums)
      , length = data.length
      , start = 0
      // 每块的大小
      , slot = chunkSize > length ? length : chunkSize
      , end = slot
      // Updated when a block matches
      , lastMatchedEnd = 0
      // 保存每个字节轮训后计算的adler32校验值
      , prevRollingWeak = null;

    for (; end <= length; start++, end++) {
        var weak = hash.weak32(data.slice(start,end), prevRollingWeak, start, end)
          , weak16 = hash.weak16(weak.sum)
          , match = false;
        // 保存上次计算的checksum  
        prevRollingWeak = weak;

        // 开始摘要对比
        if (hashtable[weak16]) {    
            var len = hashtable[weak16].length
              , i = 0;
            for (; i < len; i++) { 
                // 先比较弱摘要
                if (+hashtable[weak16][i].weak === weak.sum) {  
                    var mightMatch = hashtable[weak16][i]
                      , chunk = data.slice(start, end)
                      , strong = hash.md5(chunk);

                    // 再比较强摘要  
                    if (mightMatch.strong === strong) {
                        match = mightMatch;
                        break;
                    }
                }
            }
        }

        if (match) {
            if(start < lastMatchedEnd) {  
              var d = data.slice(lastMatchedEnd - 1, end);
              results.push({
                  data: d
                , index: match.index
              });
            } else if (start - lastMatchedEnd > 0) {  
                var d = data.slice(lastMatchedEnd, start);
                results.push({
                    data: d
                  , index: match.index
                });
            } else {
                results.push({
                    index: match.index
                });
            }
            
            lastMatchedEnd = end;

            // WARNING: 曾经采用“若匹配一个数据块，则跳过一个块大小的字节继续轮训”，但是这对于多字节的字符有影响，如汉字默认采用utf8，占3个字节，一旦一个块切断了汉字的连续三个字节，出现乱码
            // 跳过chunksize大小继续轮训
            // start += (slot - 1);
            // if((end + slot - 1) >= length){
            //     start = end - 1;
            //     end = length - 1;
            // }else{
            //     end += slot - 1;
            // }
            // // 重新计算adler32
            // prevRollingWeak = null;
        } else if (end === length) {
            // 到最后若没匹配，则直接clone修改的文本，全部替换
            var d = data.slice(lastMatchedEnd);
            results.push({
                data: d
            });
        }
    }

    return results;
}

var RSync = function (root,size) {
    this.root = root;
    // 文件块大小
    this.size = size;

    // file cache
    this.cache = {};
};

util.inherits(RSync, EventEmitter);

RSync.prototype = {
    checksumYield: function(path){
        var self = this;
        return function(done){
            fs.readFile(path, function (err, data) {
                if (err) { 
                    return done(err); 
                }

                var length     = data.length
                , incr       = self.size
                , start      = 0
                , end        = incr > length ? length : incr
                , blockIndex = 0;          
                try{
                    // cache file
                self.cache[path] = data;

                var result = '';
                while (start < length) {
                    var chunk  = data.slice(start, end)
                    , weak   = hash.weak32(chunk).sum
                    , strong = hash.md5(chunk);  

                    result += '$' + blockIndex.toString().length + '\r\n';
                    result += blockIndex + '\r\n'
                    result += '$' + weak.toString().length + '\r\n';
                    result += weak + '\r\n';
                    result += '$32\r\n';
                    result += strong + '\r\n';
                    result += '$\r\n';

                    // update slice indices
                    start += incr;
                    end = (end + incr) > length ? length : end + incr;

                    // update block index
                    blockIndex++;
                }
                }catch(e){
                    console.log(e);
                }
                
                
                return done(null, result);
            });
        }
    },
    checksum: function (path, callback) {
        var self = this;

        fs.readFile(path, function (err, data) {
            if (err) { return callback(err); }

            var length     = data.length
              , incr       = self.size
              , start      = 0
              , end        = incr > length ? length : incr
              , blockIndex = 0;          
            
            // cache file
            self.cache[path] = data;

            var result = '';

            while (start < length) {
                var chunk  = data.slice(start, end)
                  , weak   = hash.weak32(chunk).sum
                  , strong = hash.md5(chunk); 
                result += '$' + blockIndex.toString().length + '\r\n';
                result += blockIndex + '\r\n'
                result += '$' + weak.toString().length + '\r\n';
                result += weak + '\r\n';
                result += '$32\r\n';
                result += strong + '\r\n';
                result += '$\r\n';

                // update slice indices
                start += incr;
                end = (end + incr) > length ? length : end + incr;

                // update block index
                blockIndex++;
            }
            
            return callback(null, result);
        });
    },
    //
    // 根据校验和计算diff
    //
    diff: function (path, checksums, callback) {
        var self = this;

        // 本地文件删除
        if(!fs.existsSync(path)){
            return callback(null,{
                remove: true
            });
        }
        // 逐字节轮训
        fs.readFile(path,'utf-8',function (err, data) {
            if (err) { return callback(err); }
            return callback(null, roll(data, checksums, self.size));
        });
    },
    //
    // 根据diff结果恢复文件
    //
    sync: function (path, diff, callback) {
        var self = this
          , path = path
          , raw = this.cache[path]
          , i = 0
          , len = diff.length;

        if(typeof raw === 'undefined') {
          var err = new Error('must do checksum() first');
          return callback(err, null);
        }

        function rawslice(index) {
          var start = index*self.size
            , end = start + self.size > raw.length 
                  ? raw.length 
                  : start + self.size;

          return raw.slice(start, end);
        }

        var synced = '';
        
        if(!Array.isArray(diff) && diff.remove){
            // 本地文件删除，则同步到对端，也删除
            fs.unlink(path);
            delete this.cache[path];
            return callback(null, null);
        }else{ 
            for(; i < len; i++) {
                var chunk = diff[i];
                // 相同的文件块
                if(typeof chunk.data === 'undefined') { 
                    synced += rawslice(chunk.index).toString();
                } else { // 改动的部分
                    synced += chunk.data.toString();

                    if(typeof chunk.index !== 'undefined') {
                    synced += rawslice(chunk.index).toString();
                    }
                }
            }

            delete this.cache[path];
            raw = new Buffer(synced);

            return callback(null, raw);
        }
    }
};

exports.createRsync = function (root, size) {
    if(!isNaN(parseInt(root))){
        return new RSync('', root);
    }  
    return new RSync(root, size || 750);
};
