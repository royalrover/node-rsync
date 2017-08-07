const crypto = require('crypto');

module.exports = {
    md5: function (data) {
        return crypto.createHash('md5')
                     .update(data)
                     .digest('hex');
    },
    // Adler-32通过求解两个16位的数值A、B实现，并将结果连结成一个32位整数.
    // A就是字符串中每个字节的和，而B是A在相加时每一步的阶段值之和。在Adler-32开始运行时，A初始化为1，B初始化为0，最后的校验和要模上65521(继216之后的最小素数)。
    // 具体算法： https://rsync.samba.org/tech_report/node3.html
    // @params: data [Buffer] 计算的二进制数据chunk
    // @params: prev [{a: a,b: b, sum: sum}] 上一个字节开始的字节块计算的弱摘要
    // @params: start [number] 本次计算的起始索引
    // @params: end [number] 结束索引
    weak32: function (data, prev, start, end) {
        let a = 1
          , b = 0
          , sum = 0
          , M = 65521;
        
        // 首次计算弱摘要
        if(!prev){
            let len = start >= 0 && end >= 0 ? end - start : data.length
            , i = 0;

            for (; i < len; i++) {
                a += data[i];
                b += a;
            }

            a %= M;
            b %= M;
        }else{
            let k = start 
              , l = end - 1
              , prev_k = k - 1
              , prev_l = l - 1
              , prev_first = data[prev_k]
              , prev_last = data[prev_l]
              , curr_first = data[k]
              , curr_last = data[l];
            
            a = (prev.a - prev_first + curr_last) % M
            b = (prev.b - (prev_l - prev_k + 1) * prev_first + a) % M
        }

        return { a: a, b: b, sum: a + b * 1 << 16 };
    },
    weak16: function (data) {  
        return 0xffff & (data >> 16 ^ data * 1009);
    }
};