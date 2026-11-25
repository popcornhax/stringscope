// Generates the sample models in samples/ (binary STL gear, OBJ star). Run: node tools/make-samples.js
import { writeFileSync } from 'node:fs';
import * as THREE from '../vendor/three/three.module.js';

function gearGeometry(teeth = 14) {
  const shape = new THREE.Shape();
  const rIn = 0.8;
  const rOut = 1.0;
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const pts = [
      [rIn, a0],
      [rOut, a0 + step * 0.15],
      [rOut, a0 + step * 0.45],
      [rIn, a0 + step * 0.6],
    ];
    pts.forEach(([r, a], k) => {
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0 && k === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.3, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.04, bevelSegments: 3, curveSegments: 32 });
}

function starGeometry(points = 5) {
  const shape = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? 0.45 : 1.0;
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.12, bevelSegments: 6 });
}

function toBinarySTL(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position;
  const tris = pos.count / 3;
  const buf = Buffer.alloc(84 + tris * 50);
  buf.write('StringScope sample gear', 0);
  buf.writeUInt32LE(tris, 80);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  let o = 84;
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
    for (const v of [n, a, b, c]) {
      buf.writeFloatLE(v.x, o);
      buf.writeFloatLE(v.y, o + 4);
      buf.writeFloatLE(v.z, o + 8);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

function toOBJ(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position;
  const lines = ['# StringScope sample star', 'o star'];
  for (let i = 0; i < pos.count; i++) lines.push(`v ${pos.getX(i).toFixed(5)} ${pos.getY(i).toFixed(5)} ${pos.getZ(i).toFixed(5)}`);
  for (let i = 0; i < pos.count; i += 3) lines.push(`f ${i + 1} ${i + 2} ${i + 3}`);
  return lines.join('\n') + '\n';
}

const out = new URL('../samples/', import.meta.url);
writeFileSync(new URL('gear.stl', out), toBinarySTL(gearGeometry()));
writeFileSync(new URL('star.obj', out), toOBJ(starGeometry()));
console.log('wrote samples/gear.stl and samples/star.obj');
