var path = require('path');
var fs = require('fs');
var io = require('socket.io')();
var socketStream = require('socket.io-stream');
var eventStream = require('event-stream');
var co = require('co');
var rsync = require('../../../index').rsync(2 * 1024);
var workspace = path.join(process.cwd(),'./test/socket/server/files');

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

io.on('connection', function (_socket) {
    console.log('已开启websocket服务器，侦听端口 9090...');

    console.log('服务端rsync服务开启...');

    // 遍历同步目录下的所有文件，计算校验和，最后传输校验文件
    co(function*(){
        const stream = socketStream.createStream();
        stream.on('error', function (_err) {
            console.log(_err);
        });

        socketStream(_socket).emit('server:ws-checksumfile', stream, {});

        // 遍历当前工作目录，计算checksum，用json保存
        let fileInfo = {},
        files = fs.readdirSync(workspace),
        readStream = new ReadStream();    

        // length属性，用于在client端甄别“新增加的文件”
        fileInfo['__length__'] = files.length;
        for(let i=0,len=files.length;i<len;i++){
            let f = files[i];  
            fileInfo[f] = yield rsync.checksumYield(path.join(workspace,f));
        }

        // 创建流
        readStream.end(JSON.stringify(fileInfo,null,2));
        
        readStream.pipe(stream);

        stream.on('end', function (_err, _msg) {
            if (_err) {
                console.log(_err);
            }
            console.log('checksum文件发送完成')
        });
    });

    // 从客户端拿到diff描述文件，开始文件更新
    socketStream(_socket).on('client:ws-fileDiff', function(_stream, _data){
        _stream
        .pipe(eventStream.mapSync(function (data) {
            var diff = JSON.parse(data.toString()),    
            filePath = path.join(workspace,_data.filename);  

            // diff为[{index: 0},{index: 1}...,{index: n}]，意味着两端的文件并没有改变，因此不用进行更新，这种情况发生在文件大小小于blockSize的情况；
            // 如果文件大小大于blockSize，即使文件没有变动，diff的结果也会类似[{index: 0},{index: 1}...,{data: 'jdjjdksdkfh'}]，此种情况无法判断是否变动
            if(Array.isArray(diff) && diff.every((item)=>{
                    return typeof item.index == 'number' && !item.data;
                })){
                return;
            }

            rsync.sync(filePath,diff,function(err,content){
                if(err){
                    return console.log(`${filePath}写入错误,${err.stack}`);
                }   
                // content类型为buffer,也肯能为空
                if(content instanceof Buffer){
                    fs.writeFile(filePath,content,'utf8',function(){
                        console.log(`${filePath}写入完成`);
                    });
                }
            });
        }));
    });
});

io.listen(9090);