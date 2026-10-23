// Run through SSH on dacp. Credentials stay on the host and are never printed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const root = 'C:/ProgramData/RightDataServer';
const phase = process.argv[2];
if (!['create', 'verify'].includes(phase)) throw new Error('Expected create or verify phase');
const credentials = JSON.parse(await readFile(`${root}/credentials.json`, 'utf8'));
const base = 'http://127.0.0.1:8003';
let token = '';
async function api(path, method='GET', body, key) {
  const response = await fetch(base + path, { method, headers: { ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body && !(body instanceof FormData) ? {'Content-Type':'application/json'} : {}), ...(key ? {'Idempotency-Key':key} : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const envelope = await response.json();
  assert.equal(response.ok, true, `${path}: ${envelope.code}`);
  assert.equal(envelope.code, 'ok', `${path}: ${envelope.code}`);
  return envelope.data;
}
async function job(id) {
  for (let i=0; i<120; i++) {
    const result = await api(`/api/v1/jobs/${id}`);
    if (result.state === 'succeeded') return result;
    if (['failed','canceled','expired'].includes(result.state)) throw new Error(`Job ${result.state}: ${result.error}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Job timed out');
}
const probe = await api('/api/probe');
assert.equal(probe.service, 'RightData');
assert.equal(probe.ready, true);
const unauthorized = await fetch(`${base}/api/v1/datasets`, { signal: AbortSignal.timeout(10000) });
assert.equal(unauthorized.status, 401);
const session = await api('/api/v1/auth/login', 'POST', { username:credentials.username, password:credentials.password, remember:false });
token = session.accessToken;
assert.equal((await api('/api/v1/auth/me')).username, credentials.username);
let state;
try {
  if (phase === 'create') {
    const created = await api('/api/v1/data-files', 'POST', { name:`deploy-check-${randomUUID()}.duckdb`, password:randomUUID() });
    state = { databaseId:created.id, instanceId:probe.instanceId, exactId:'9007199254740993', version:JSON.parse(await readFile(`${root}/current.json`)).version };
    await writeFile(`${root}/logs/acceptance-state.json`, JSON.stringify(state));
    await api(`/api/v1/datasets/${state.databaseId}/schema:mutate`, 'POST', {
      action:'create_table', table:'release_check', fields:[{name:'id',dataType:'BIGINT',primaryKey:true,nullable:false},{name:'amount',dataType:'DECIMAL(24,4)',nullable:false},{name:'label',dataType:'VARCHAR'}],
    }, randomUUID());
    const csv = 'id,amount,label\n9007199254740993,12345678901234567890.1234,release_check\n';
    const form = new FormData(); form.set('purpose','import'); form.set('file',new Blob([csv],{type:'application/vnd.rightdata.import+csv'}),'release-check.csv');
    const uploaded = await api('/api/v1/uploads','POST',form);
    state.uploadId = uploaded.uploadId;
    await writeFile(`${root}/logs/acceptance-state.json`, JSON.stringify(state));
    const imported = await api('/api/v1/import-jobs','POST',{datasetId:state.databaseId,table:'release_check',uploadId:uploaded.uploadId,mode:'append',columns:['id','amount','label']},randomUUID());
    await job(imported.jobId);
    const writeKey = randomUUID();
    const mutation = {operations:[{action:'insert',values:{id:'2',amount:'0.0100',label:'retry_once'}}]};
    const first = await api(`/api/v1/datasets/${state.databaseId}/tables/release_check/records:mutate`,'POST',mutation,writeKey);
    assert.deepEqual(await api(`/api/v1/datasets/${state.databaseId}/tables/release_check/records:mutate`,'POST',mutation,writeKey),first);
  } else {
    state = JSON.parse(await readFile(`${root}/logs/acceptance-state.json`));
    assert.equal(probe.instanceId,state.instanceId);
  }
  const queried = await api(`/api/v1/datasets/${state.databaseId}/tables/release_check/query`,'POST',{fields:['id','amount','label'],limit:10,offset:0});
  assert.equal(queried.total,2);
  assert.equal(queried.rows.find(row=>row.id===state.exactId)?.amount,'12345678901234567890.1234');
  if (phase === 'verify') {
    const exported = await api('/api/v1/export-jobs','POST',{datasetId:state.databaseId,table:'release_check',fields:['id','amount','label']},randomUUID());
    await job(exported.jobId);
    const response = await fetch(`${base}/api/v1/jobs/${exported.jobId}/download`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
    assert.equal(response.ok,true);
    const records = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(records[0].type,'schema');
    assert.equal(records.at(-1).complete,true);
    assert.equal(records.filter(row=>row.type==='chunk').flatMap(row=>row.rows).some(row=>row[0]===state.exactId&&row[1]==='12345678901234567890.1234'),true);
    await api(`/api/v1/data-files/${state.databaseId}`,'DELETE');
    if (state.uploadId) await api(`/api/v1/files/${state.uploadId}`,'DELETE');
  }
  const result = { phase, passed:true, version:state.version, instanceId:probe.instanceId, checks:phase==='create'?['probe','unauthorized_rejected','login','database','schema','csv_import','idempotent_insert','exact_numeric_query']:['same_instance_after_restart','persisted_data','exact_numeric_export','temporary_data_removed'], at:new Date().toISOString() };
  await writeFile(`${root}/logs/acceptance-${phase}.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  await api('/api/v1/auth/logout','POST',{});
}
