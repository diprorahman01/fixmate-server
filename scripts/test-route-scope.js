// Standalone regression checks for router mount matching.
// Checks that an API endpoint enters only its own scoped router.
import assert from "node:assert/strict";
const service=(m,p)=>(m==="GET"&&/^\/technician\/services(?:\/[^/]+)?$/.test(p))||(m==="POST"&&p==="/services")||(["PATCH","DELETE"].includes(m)&&/^\/services\/[^/]+(?:\/availability)?$/.test(p));
const admin=(m,p)=>(m==="GET"&&["/stats","/services","/users"].includes(p))||(m==="PATCH"&&(/^\/services\/[^/]+\/approval$/.test(p)||/^\/users\/[^/]+\/role$/.test(p)));
const booking=(m,p)=>(m==="POST"&&p==="/bookings")||(m==="GET"&&["/customer/bookings","/technician/requests","/admin/bookings"].includes(p))||(m==="PATCH"&&(/^\/bookings\/[^/]+\/cancel$/.test(p)||/^\/technician\/requests\/[^/]+\/status$/.test(p)));
const payment=(m,p)=>(m==="POST"&&p==="/payments/create-checkout-session")||(m==="GET"&&["/payments/verify","/customer/payments","/admin/transactions"].includes(p));
const profile=(m,p)=>((["GET","PATCH"].includes(m)&&p==="/profile")||(m==="POST"&&p==="/profile/image"));
const cases=[
  ["GET","/customer/bookings","booking"],["GET","/customer/payments","payment"],["GET","/admin/bookings","booking"],["GET","/admin/transactions","payment"],["GET","/profile","profile"],["PATCH","/profile","profile"],["POST","/profile/image","profile"],["GET","/technician/services","service"],["POST","/services","service"],["PATCH","/services/0123456789abcdef01234567","service"],["POST","/bookings","booking"],["POST","/payments/create-checkout-session","payment"],["GET","/health",null],["GET","/services",null],
];
for(const [m,p,expected] of cases){
  const found=[];if(service(m,p))found.push("service");
  const adminPath=p.startsWith("/admin/")?p.slice(6):p;
  if(p.startsWith("/admin/")&&admin(m,adminPath))found.push("admin");
  if(booking(m,p))found.push("booking");if(payment(m,p))found.push("payment");if(profile(m,p))found.push("profile");
  assert.deepEqual(found,expected?[expected]:[],`${m} ${p} got ${found}`);
}
console.log(`${cases.length} router-scope regression checks passed`);
