## rsync原理
rsync算法用于同步客户端和服务器的文件内容，它是以文件块为粒度的同步算法。由于使用rsync模块需要设计两端的通信，因此常用的通信媒介就是socket。

rsync首先会计算服务端文件列表中每个文件的校验值，并将该值聚合为一个checksum文件以stream的形式发送给客户端；

客户端接受到checksum文件后开始针对每个文件做diff，该diff算法正是以文件块为单位进行比对，并将每个文件的diff结果返回给服务端；

服务端接受diff结果，恢复文件；

这样通过宏观上的三步流程，实现远程文件的同步。

## rsync模块使用示例
由于rsync算法涉及到两端，因此给出两端的不同实现：

SERVER 端：
```
var path = require('path');
var fs = require('fs');
var io = require('socket.io')(8080);
var socketStream = require('socket.io-stream');
var eventStream = require('event-stream');
var co = require('co');
var rsync = require('rsync').createRsync(2 * 1024);
var workspace = '~/test/server/sync';

io.on('connection', function (_socket) {
    _socket.on('cli:ws-changedFiles',function(_data){
        console.log('开始计算校验文件...');
        // 遍历同步目录下的所有文件，计算校验和，最后传输校验文件
        co(function*(){
            const stream = socketStream.createStream();
            stream.on('error', function (_err) {
                console.log(_err);
            });

            socketStream(_socket).emit('server:ws-checksumfile', stream, {});

            // 遍历当前工作目录，计算checksum，用json保存
            let fileInfo = {},
            files = _data.changedFiles,
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

```

CLIENT 端
```
var path = require('path');
var fs = require('fs');
var socketIo = require('socket.io-client');
var socketStream = require('socket.io-stream');
var jstream = require('JSONStream');
var es = require('event-stream');
var rsync = require('rsync').createRsync(2 * 1024);
var workspace = '~/test/client/sync';

socket = socketIo.connect('127.0.0.1:8080', {
    'force new connection': true,
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
socket.emit('cli:ws-changedFiles',{changedFiles: fs.readdirSync(workspace)});

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
        console.log(_msg);
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
```