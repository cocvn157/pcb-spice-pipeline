// Copied from tests/model-source.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import {loadModelSource} from '../../src/buffers/index.js'
import {sha256} from '../../src/kernel/index.js'

const bytes=Buffer.from('\uFEFF[IBIS Ver] 4.2\r\n[File Name] driver.ibs\r\n[End]\r\n')
const asset={project_relative_path:'models/driver.ibs',url:'https://vendor.example/driver.ibs',mimetype:'text/plain'}
const model=ibis_model_asset=>({pipelineId:'model-0',ibis_model_asset})

test('provided IBIS text and bytes retain BOM, CRLF and exact source hashes',()=>{
  for(const source of [bytes,bytes.toString('utf8')]) {
    const loaded=loadModelSource(model(asset),{[asset.project_relative_path]:source})
    assert.deepEqual([...loaded.bytes],[...bytes])
    assert.equal(loaded.text,bytes.toString('utf8'))
    assert.equal(loaded.evidence.sourceSha256,sha256(bytes))
    assert.equal(loaded.evidence.rawSourceSha256,sha256(bytes))
    assert.equal(loaded.evidence.resolvedFrom,'provided')
  }
})
test('missing bytes never resolve or download the declared URL',()=>{
  assert.throws(()=>loadModelSource(model(asset),{}),/ibis_asset_missing/)
  assert.throws(()=>loadModelSource(model({...asset,project_relative_path:'toString'}),{}),/ibis_asset_missing/)
})
test('model paths cannot escape the explicit project',()=>{
  for(const path of ['../outside.ibs','/outside.ibs','C:/outside.ibs','a\\b.ibs','a/../b.ibs','a\0.ibs'])
    assert.throws(()=>loadModelSource(model({...asset,project_relative_path:path}),{[path]:bytes}),/file_path/)
})
test('model loading rejects HTML, ZIP, invalid UTF-8 and oversized data',()=>{
  for(const payload of ['<!doctype html><title>Download</title>','PK\x03\x04archive',Buffer.from([0xc3,0x28]),new Uint8Array(64*1024*1024+1),42])
    assert.throws(()=>loadModelSource(model(asset),{[asset.project_relative_path]:payload}),/IBIS|plain|ZIP|UTF|HTML|encoded|expected/i)
})
