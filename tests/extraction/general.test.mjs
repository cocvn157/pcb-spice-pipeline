// Copied from tests/general.test.mjs: the single-lane extraction/reduction test. Assertions unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import {geometryFromCircuitJson} from '../../src/board/index.js'
import {fastHenryDeck,fasterCapDeck,loopImpedance,referenceCapacitance} from '../../src/extraction/index.js'
import {circuit,physical} from '../fixtures/general.mjs'

test('one signal extraction retains its explicit return and correct 2x2 reduction',()=>{
  const m={...physical,lanes:[physical.lanes[0]]},geometry=geometryFromCircuitJson(circuit,m)
  assert.equal(geometry.cells[0].conductors.length,2)
  assert.equal((fastHenryDeck(geometry.cells[0],m.extraction).match(/\.external /g)??[]).length,2)
  assert.equal(Object.keys(fasterCapDeck(geometry.cells[0],m.extraction)).length,3)
  assert.deepEqual(loopImpedance([[2,.1],[.1,3]]),[[4.8]])
  const C=referenceCapacitance([[4,-1],[-1,3]])
  assert.ok(Math.abs(C.matrix[0][0]-2.2)<1e-15)
})
