var path = require('path');
var fs = require('fs');
var socketIo = require('socket.io-client');
var socketStream = require('socket.io-stream');
var jstream = require('JSONStream');
var es = require('event-stream');
var rsync = require('../../../index').rsync(2 * 1024);
var workspace = path.join(process.cwd(),'./test/socket/client/files');

// ReadStream
var Readable = require('stream').Readable;
var inherits = require('util').inherits;

inherits(ReadStream, Readable);

function ReadStream(context) {
  Readable.call(this, {});
}

ReadStream.prototype._read = function (){};

ReadStream.prototype.end = function(data){
  this.push(data);
  this.push(null);
};

socket = socketIo('http://localhost:9090', {
    forceNew: true,
    transports: ['websocket'],
});

socket.on('error', function (err) {
    done(err);
});

socket.on('disconnect',function(){
    console.log('connection is break!');
    process.exit(1);
});

// 发送给服务端改动的文件
socket.emit('cli:ws-changedFiles',{
    files: fs.readdirSync(workspace)
});

// 接收服务端发来的校验文件
socketStream(socket).on('server:ws-checksumfile', function (_stream, _data) {

    _stream.on('end', function () {
        console.log('拿到服务端文件记录表');
    });

    // 流式解析json文件
    var serverFileLength,
    diffFromStream = function(){
        _stream
        .pipe(jstream.parse('$*')) // 获取key和value
        .pipe(es.mapSync(function (data) {
            var filename = data.key,
            checksum = data.value,
            filePath = path.join(process.cwd(),filename);

            if(typeof serverFileLength == 'number'){
                serverFileLength--;
            }
            // 记录server端文件总数
            // checksum文件的第一项为服务端文件总数，为源信息，因此不需要针对该信息做idff
            if(filename == '__length__'){
                serverFileLength = +checksum;
            }else{
                sendDiffInfo(socket,filename,checksum);
            }
            // 服务端文件的checksum校验完毕后
            if(serverFileLength == 0){
                console.log('本地文件全部diff完毕');
            }
        }));
    };

    try{
        diffFromStream();
    }catch(e){
        console.log(e.message);
        process.exit(1);
    }
});

// 根据获取的校验值，与本地的文件做diff差值
function sendDiffInfo(socket,filename,checksum){
    // 创建 基于2k字节的文件块 的rsync，与服务端同步
    const stream = socketStream.createStream();
    stream.on('error', function (_err) {
        console.log(_err);
    });

    socketStream(socket).emit('client:ws-fileDiff', stream, {
        filename: filename
    });

    stream.on('end', function (_err, _msg) {
        if (_err) {
            return console.log(_err.message);
        }
    });

    rsync.diff(path.join(workspace,filename),checksum,function(e,diff){
        if(e){
            return console.log(e);
        }
        var readStream = new ReadStream();
        // 创建流
        readStream.end(JSON.stringify(diff,null,2));
        readStream.pipe(stream);
    });
}