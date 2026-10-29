import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildRelay,issueTicket,verifyTicket } from '../src/relay.js';
test('relay tickets bind room, peers, direction and a short expiry',()=>{
  const key=randomBytes(32),now=Date.now();const a=verifyTicket(key,issueTicket(key,'room','a','b',now),now),b=verifyTicket(key,issueTicket(key,'room','b','a',now),now);
  assert.equal(a.channel,b.channel);assert.notEqual(a.side,b.side);
  assert.notEqual(a.channel,verifyTicket(key,issueTicket(key,'other','a','b',now),now).channel);
  assert.throws(()=>verifyTicket(randomBytes(32),issueTicket(key,'room','a','b',now),now));assert.throws(()=>verifyTicket(key,issueTicket(key,'room','a','b',now),now+61000));
});
test('separate relay forwards opaque frames, bounds queues and rejects unauthorized traffic',async()=>{
  const key=randomBytes(32),app=await buildRelay(key);try{
    const a=issueTicket(key,'room','a','b'),b=issueTicket(key,'room','b','a'),foreign=issueTicket(key,'other','a','b');
    const frame=randomBytes(2048),headers={authorization:`Bearer ${a}`,'content-type':'application/octet-stream'};
    assert.equal((await app.inject({method:'POST',url:'/v2/relay/send',headers,payload:frame})).statusCode,202);
    assert.equal((await app.inject({method:'POST',url:'/v2/relay/send',headers,payload:frame})).statusCode,429);
    assert.equal((await app.inject({url:'/v2/relay/receive',headers:{authorization:'Bearer invalid'}})).statusCode,401);
    const received=await app.inject({url:'/v2/relay/receive',headers:{authorization:`Bearer ${b}`}});assert.equal(received.statusCode,200);assert.deepEqual(received.rawPayload,frame);
    const pending=app.inject({url:'/v2/relay/receive',headers:{authorization:`Bearer ${b}`}});await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal((await app.inject({method:'POST',url:'/v2/relay/send',headers,payload:frame})).statusCode,202);assert.deepEqual((await pending).rawPayload,frame);
    assert.equal((await app.inject({method:'POST',url:'/v2/relay/send',headers:{authorization:`Bearer ${foreign}`,'content-type':'application/octet-stream'},payload:frame})).statusCode,202);
    const health=(await app.inject('/health')).json();assert.equal(health.bufferedBytes,frame.length);
  }finally{await app.close();}
});

test('relay ingress and egress ceilings apply to simultaneous frames and retain in-flight accounting',async()=>{
  const key=randomBytes(32),app=await buildRelay(key,{ingressBytesPerSecond:32768,
    egressBytesPerSecond:32768,maximumBufferedBytes:2*1024*1024});
  try {
    const frame=randomBytes(16384),send=async(room:string)=>app.inject({method:'POST',url:'/v2/relay/send',
      headers:{authorization:`Bearer ${issueTicket(key,room,'a','b')}`,'content-type':'application/octet-stream'},payload:frame});
    const start=performance.now();
    const sent=await Promise.all([send('one'),send('two')]);
    assert.ok(sent.every(r=>r.statusCode===202));assert.ok(performance.now()-start>=700);
    assert.equal((await app.inject('/health')).json().bufferedBytes,32768);
    const receiving=app.inject({url:'/v2/relay/receive',headers:{authorization:`Bearer ${issueTicket(key,'one','b','a')}`}});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal((await app.inject('/health')).json().bufferedBytes,32768);
    assert.equal((await app.inject({url:'/v2/relay/receive',headers:{authorization:`Bearer ${issueTicket(key,'one','b','a')}`}})).statusCode,409);
    assert.deepEqual((await receiving).rawPayload,frame);
    assert.equal((await app.inject('/health')).json().bufferedBytes,16384);
    assert.deepEqual((await app.inject({url:'/v2/relay/receive',headers:{authorization:`Bearer ${issueTicket(key,'two','b','a')}`}})).rawPayload,frame);
    assert.equal((await app.inject('/health')).json().bufferedBytes,0);
  } finally {await app.close();}
});

test('relay rejects excess reservations, malformed bodies and invalid operator limits',async()=>{
  const key=randomBytes(32),app=await buildRelay(key,{maximumChannels:1,maximumBufferedBytes:2*1024*1024});
  try {
    const headers={authorization:`Bearer ${issueTicket(key,'room','a','b')}`,'content-type':'application/octet-stream'};
    assert.equal((await app.inject({method:'POST',url:'/v2/relay/send',headers,payload:randomBytes(16)})).statusCode,411);
    assert.equal((await app.inject({method:'POST',url:'/v2/relay/send',headers,payload:randomBytes(2*1024*1024)})).statusCode,202);
    assert.equal((await app.inject({method:'POST',url:'/v2/relay/send',headers,payload:randomBytes(28)})).statusCode,429);
    assert.equal((await app.inject({url:'/v2/relay/receive',headers:{authorization:`Bearer ${issueTicket(key,'other','b','a')}`}})).statusCode,503);
    assert.equal((await app.inject('/health')).json().incomingBytes,0);
  } finally {await app.close();}
  await assert.rejects(()=>buildRelay(key,{egressBytesPerSecond:-1}));
  await assert.rejects(()=>buildRelay(key,{maximumBufferedBytes:1}));
});
