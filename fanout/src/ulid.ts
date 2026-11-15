const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastMs = 0
let lastRand = new Array(16).fill(0)

function rand16(): number[] {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b % 32)
}

export function newId(): string {
  let ms = Date.now()
  if (ms < lastMs) ms = lastMs
  if (ms === lastMs) {
    let carry = true
    for (let i = 15; i >= 0 && carry; i--) {
      lastRand[i] += 1
      if (lastRand[i] >= 32) lastRand[i] = 0
      else carry = false
    }
    if (carry) {
      ms += 1
      lastRand = rand16()
    }
  } else {
    lastRand = rand16()
  }
  lastMs = ms
  let time = ms
  let head = ''
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head
    time = Math.floor(time / 32)
  }
  return head + lastRand.map((n) => CROCKFORD[n]).join('')
}
