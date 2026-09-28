const {test, afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
process.env.VERCEL='1';process.env.RATE_MARKUP_PERCENT='0';
require('../dist/utils/logger').default.silent=true;
const Shipment=require('../dist/models/Shipment').default;
require('../dist/models/SavedQuote').default.findOneAndUpdate=async()=>null;
const carrier=require('../dist/services/netparcel.service').default;
const controller=require('../dist/controllers/shipment.controller');
const payment=require('../dist/services/payment.service');
const payments=require('../dist/controllers/payment.controller');
const {downloadInvoice}=require('../dist/controllers/invoice.controller');
const {errorHandler}=require('../dist/middleware/error.middleware');
const postal=require('../dist/utils/postal');
const {lookupPostal}=require('../dist/services/postal.service');
const axios=require('axios');
const originals=[];
function stub(object,key,fn){originals.push([object,key,object[key]]);object[key]=fn;}
afterEach(()=>{while(originals.length){const [o,k,v]=originals.pop();o[k]=v;}});
const id='507f1f77bcf86cd799439011',owner='507f191e810c19729de860ea';
const address={name:'Test Person',street:'Test Street',city:'Toronto',province:'ON',postalCode:'M5V3A8',country:'CA',phone:'4165550100',addressType:'business'};
const parcel={weight:5,weightUnit:'lbs',length:10,width:8,height:6,dimensionUnit:'in',description:'Test',quantity:1,freightClass:'77.5',specialHandling:true,insuranceAmount:10};
const raw={service_code:'123',service_name:'Test Ground',total_price:'600.00',currency:'CAD',transit_days:2};
const quote={originPostal:'M5V3A8',destinationPostal:'V6B1A1',originCity:'Toronto',destinationCity:'Vancouver',packages:[parcel],shipperType:'business',consigneeType:'consumer'};
const rate={serviceCode:'123',carrierId:'123',carrierName:'Test',serviceName:'Test Ground',totalCharge:600,currency:'CAD',transitDays:2};
const booking={shipper:address,recipient:address,parcels:[parcel],selectedRate:rate,shipmentType:'domestic',packagingType:'Pallet',pickupDetails:{method:'drop_off'}};
function document(){return new Shipment({_id:id,userId:owner,shipmentNumber:'PC-TEST',...booking,status:'pending_payment',payment:{amount:600,currency:'CAD',priceVerified:true,status:'pending',stripeIntentId:'pi_test',paypalOrderId:'PPTEST'}});}
function intent(s=document()){return {id:'pi_test',metadata:{shipmentId:String(s._id),userId:String(s.userId)},status:'succeeded',currency:'cad',amount:60000,amount_received:60000};}
function paypal(){return {id:'PPTEST',status:'COMPLETED',purchase_units:[{custom_id:id,reference_id:'PC-TEST',amount:{currency_code:'CAD',value:'600.00'},payments:{captures:[{status:'COMPLETED',amount:{currency_code:'CAD',value:'600.00'}}]}}]};}
async function invoke(fn,{body={},params={id},user={userId:owner},headers={},query={}}={}){
 let status=200,data;const res={status(n){status=n;return this},json(v){data=v;return this},send(v){data=v;return this}};
 await fn({body,params,user,headers,query},res,e=>{status=e.statusCode||500;data={success:false,message:e.message}});return {status,data};
}
for(const amount of ['499.99','500','501','600.00','1000',10000])test(`decimal price ${amount} retains documented units`,async()=>{
 stub(carrier,'getRates',async()=>[{...raw,total_price:amount}]);const r=await invoke(controller.getRates,{body:quote});assert.equal(r.status,200);assert.equal(r.data.rates[0].totalCharge,Number(amount));
});
test('booking re-rates, rejects tampering and persists only provider selection',async()=>{
 let saved,called=0;stub(carrier,'getRates',async p=>{called++;assert.equal(p.rate.shipper_type,'business');assert.equal(p.rate.packaging_information.packaging_type,'Pallet');return [raw]});
 stub(Shipment,'create',async data=>{saved=data;return new Shipment(data)});
 let r=await invoke(controller.bookShipment,{body:{...booking,selectedRate:{...rate,totalCharge:0.01}}});assert.equal(r.status,409);assert.equal(saved,undefined);
 r=await invoke(controller.bookShipment,{body:{...booking,selectedRate:{...rate,currency:'USD'}}});assert.equal(r.status,409);
 r=await invoke(controller.bookShipment,{body:{...booking,selectedRate:{...rate,serviceName:'Forged name'}}});assert.equal(r.status,201);assert.equal(saved.payment.amount,600);assert.equal(saved.selectedRate.serviceName,'Test Ground');assert.equal(saved.payment.priceVerified,true);assert.equal(called,3);
});
test('anonymous booking never contacts carrier or persists',async()=>{stub(carrier,'getRates',()=>assert.fail('carrier'));stub(Shipment,'create',()=>assert.fail('database'));assert.equal((await invoke(controller.bookShipment,{body:booking,user:null})).status,401)});
test('party types and package type reach both carrier operations',async()=>{
 let ratePayload,shipPayload;stub(carrier,'getRates',async p=>{ratePayload=p;return[raw]});stub(carrier,'createShipment',async p=>{shipPayload=p;return{order_id:1,documents:[]}});
 assert.equal((await invoke(controller.getRates,{body:{...quote,packagingType:'Pallet'}})).status,200);
 const s=document();s.recipient.addressType='consumer';await controller.generateLabelForShipment(s);
 assert.equal(ratePayload.rate.shipper_type,'business');assert.equal(shipPayload.ship.shipper_type,'business');assert.equal(ratePayload.rate.consignee_type,'consumer');assert.equal(shipPayload.ship.consignee_type,'consumer');assert.deepEqual(shipPayload.ship.packaging_information,ratePayload.rate.packaging_information);
});
for(const change of [{destinationCity:''},{destinationPostal:''},{packages:[{...parcel,weight:-1}]},{packages:[{...parcel,length:0}]},{packagingType:'Pallet',packages:[{...parcel,freightClass:''}]}])test('invalid route/package is rejected before upstream: '+JSON.stringify(change),async()=>{stub(carrier,'getRates',()=>assert.fail('carrier'));const r=await invoke(controller.getRates,{body:{...quote,...change}});assert.equal(r.status,400)});
test('empty rates do not assert that the address caused failure',async()=>{stub(carrier,'getRates',async()=>[]);const r=await invoke(controller.getRates,{body:quote});assert.equal(r.status,422);assert.match(r.data.message,/package weight/);assert.doesNotMatch(r.data.message,/check the addresses/i)});
test('carrier package error is preserved through service and controller',async()=>{stub(carrier.client,'post',async()=>({status:200,data:{rates:[],errors:[{errorMessage:'Maximum package length is 108 inches.'}]}}));const r=await invoke(controller.getRates,{body:quote});assert.equal(r.status,422);assert.match(r.data.message,/108 inches/)});
for(const [label,mutate] of [
 ['wrong shipment',p=>p.metadata.shipmentId='other'],['wrong owner',p=>p.metadata.userId='other'],['unbound intent',p=>p.id='pi_other'],['incomplete',p=>p.status='processing'],['wrong currency',p=>p.currency='usd'],['underpaid',p=>p.amount_received=1],['wrong expected amount',p=>p.amount=1],
])test('Stripe rejects '+label,()=>{const p=intent();mutate(p);assert.equal(payment.checkStripeIntent(p,document()).ok,false)});
test('Stripe accepts only exact completed bound payment; legacy unverified booking blocked',()=>{const s=document();assert.equal(payment.checkStripeIntent(intent(s),s).ok,true);s.payment.priceVerified=false;assert.equal(payment.checkStripeIntent(intent(s),s).ok,false);assert.throws(()=>payment.requirePayable(s),/fresh quote/)});
for(const [label,mutate] of [['wrong order',p=>p.id='OTHER'],['wrong shipment',p=>p.purchase_units[0].custom_id='OTHER'],['wrong currency',p=>p.purchase_units[0].payments.captures[0].amount.currency_code='USD'],['underpaid',p=>p.purchase_units[0].payments.captures[0].amount.value='0.01'],['pending capture',p=>p.purchase_units[0].payments.captures[0].status='PENDING'],['multiple units',p=>p.purchase_units.push(p.purchase_units[0])]])test('PayPal rejects '+label,()=>{const p=paypal();mutate(p);assert.equal(payment.checkPayPalCapture(p,document()).ok,false)});
test('PayPal verifies a completed bound capture',()=>assert.equal(payment.checkPayPalCapture(paypal(),document()).ok,true));
test('confirmation verifies ownership before consulting Stripe',async()=>{stub(Shipment,'findById',async()=>document());stub(payment.stripe.paymentIntents,'retrieve',()=>assert.fail('Stripe'));assert.equal((await invoke(controller.confirmPayment,{body:{method:'stripe',transactionId:'pi_test'},user:{userId:'other'}})).status,403);assert.equal((await invoke(controller.confirmPayment,{body:{method:'wise',transactionId:'anything'}})).status,400)});
test('Stripe confirmation refuses unpaid intent without booking',async()=>{stub(Shipment,'findById',async()=>document());stub(payment.stripe.paymentIntents,'retrieve',async()=>({...intent(),status:'requires_payment_method'}));stub(carrier,'createShipment',()=>assert.fail('carrier'));assert.equal((await invoke(controller.confirmPayment,{body:{method:'stripe',transactionId:'pi_test'}})).status,400)});
test('client/webhook concurrent completion claims exactly one carrier booking',async()=>{
 const s=document();let claimed=false,calls=0;stub(Shipment,'findOneAndUpdate',async(filter,update)=>{assert.equal(filter['payment.status'],'pending');assert.equal(filter['payment.stripeIntentId'],'pi_test');if(claimed)return null;claimed=true;s.payment.status='completed';s.payment.transactionId='pi_test';s.status='paid';return s});
 stub(Shipment,'findById',async()=>s);stub(s,'save',async()=>s);stub(carrier,'createShipment',async()=>{calls++;return{order_id:99,documents:[]}});
 await Promise.all([payment.settlePayment(s,'stripe','pi_test'),payment.settlePayment(s,'stripe','pi_test')]);assert.equal(calls,1);assert.equal(s.netparcelOrderId,99);
});
test('cancelled pending shipment cannot be settled',async()=>{const s=document();s.status='cancelled';stub(Shipment,'findOneAndUpdate',async()=>null);stub(Shipment,'findById',async()=>s);stub(carrier,'createShipment',()=>assert.fail('carrier'));await assert.rejects(payment.settlePayment(s,'stripe','pi_test'),/state has changed/)});
test('PayPal mismatched order rejected before capture or token request',async()=>{stub(Shipment,'findById',async()=>document());stub(axios,'post',()=>assert.fail('network'));assert.equal((await invoke(payments.capturePayPalOrder,{body:{shipmentId:id,orderId:'OTHER'}})).status,400)});
test('malformed and unowned label IDs never expose labels',async()=>{stub(Shipment,'findById',()=>assert.fail('invalid ID reached database'));assert.equal((await invoke(controller.downloadLabel,{params:{id:'not-an-id'}})).status,400);assert.equal((await invoke(controller.downloadLabel,{user:null})).status,401)});
test('cancel is owner-only: anonymous, other users and ownerless guest shipments never reach carrier or database write',async()=>{
 const guest=document();guest.userId=undefined;guest.guestEmail='guest@example.com';stub(guest,'save',()=>assert.fail('saved'));stub(carrier,'cancelShipment',()=>assert.fail('carrier'));stub(Shipment,'findById',async()=>guest);
 assert.equal((await invoke(controller.cancelShipment,{user:null})).status,401);assert.equal((await invoke(controller.cancelShipment)).status,403);
 const owned=document();stub(owned,'save',()=>assert.fail('saved'));stub(Shipment,'findById',async()=>owned);assert.equal((await invoke(controller.cancelShipment,{user:{userId:'other'}})).status,403);
 assert.equal((await invoke(controller.cancelShipment,{params:{id:'not-an-id'}})).status,400);assert.equal(guest.status,'pending_payment');assert.equal(owned.status,'pending_payment');
});
test('owner can still cancel their own shipment',async()=>{const s=document();s.createdAt=new Date();let saved=false;stub(s,'save',async()=>{saved=true;return s});stub(Shipment,'findById',async()=>s);const r=await invoke(controller.cancelShipment,{body:{reason:'test'}});assert.equal(r.status,200);assert.equal(s.status,'cancelled');assert.ok(saved)});
test('cancel keeps the shipment when the carrier does not confirm CANCELLED',async()=>{
 const s=document();s.status='label_generated';s.netparcelOrderId=42;s.createdAt=new Date();stub(s,'save',()=>assert.fail('saved'));stub(Shipment,'findById',async()=>s);
 stub(carrier,'cancelShipment',async()=>({shipment:{status:'READY TO PROCESS',order_id:42},errorMessage:'Shipment already picked up.'}));
 let r=await invoke(controller.cancelShipment);assert.equal(r.status,502);assert.deepEqual(r.data.carrierErrors,['Shipment already picked up.']);assert.equal(s.status,'label_generated');
 stub(carrier,'cancelShipment',async()=>{throw Error('timeout')});r=await invoke(controller.cancelShipment);assert.equal(r.status,502);assert.equal(s.status,'label_generated');
});
test('pickup-scheduled shipment is cancellable once the carrier confirms, with the $25 dispatch deduction',async()=>{
 const s=document();s.status='pickup_scheduled';s.netparcelOrderId=42;s.createdAt=new Date();stub(s,'save',async()=>s);stub(Shipment,'findById',async()=>s);
 stub(carrier,'cancelShipment',async()=>({shipment:{status:'CANCELLED',order_id:42}}));
 const r=await invoke(controller.cancelShipment);assert.equal(r.status,200);assert.equal(s.status,'cancelled');assert.equal(r.data.refundAmount,575);
 assert.match(fs.readFileSync('../frontend/src/app/account/shipments/page.tsx','utf8'),/cancellable = [^\n]*'pickup_scheduled'/);
});
test('international customs invoice uses the documented netParcel field names',async()=>{
 let sent;stub(carrier,'createShipment',async p=>{sent=p;return{order_id:1,documents:[]}});
 const s=document();s.shipmentType='international';
 s.customsInvoice={reasonForExport:'Sale',taxType:'VAT',taxId:'GB123456789',currency:'USD',totalValue:40,products:[{quantity:2,description:'Cotton T-shirt',hsCode:'6109.10',madeIn:'CA',cusma:true,section232:true,unitPrice:20,totalPrice:40}]};
 await controller.generateLabelForShipment(s);
 assert.deepEqual(sent.ship.customs_invoice,{reason_for_export:'Sale',invoice_currency:'USD',tax_type:'VAT',tax_id:'GB123456789',items:[{description:'Cotton T-shirt',harmonized_code:'6109.10',origin_country_code:'CA',quantity:2,unit_price:20,cusma:true}]});
 s.customsInvoice.taxType='HST';await controller.generateLabelForShipment(s);assert.equal(sent.ship.customs_invoice.tax_type,undefined);assert.equal(sent.ship.customs_invoice.tax_id,undefined);
});
test('international booking requires reason for export and HS codes before re-rating',async()=>{
 stub(carrier,'getRates',()=>assert.fail('carrier'));stub(Shipment,'create',()=>assert.fail('database'));
 const product={quantity:1,description:'Cotton T-shirt',hsCode:'6109.10',madeIn:'CA',unitPrice:20,totalPrice:20};
 const intl={...booking,shipmentType:'international',customsInvoice:{currency:'CAD',products:[product]}};
 assert.equal((await invoke(controller.bookShipment,{body:intl})).status,400);
 assert.equal((await invoke(controller.bookShipment,{body:{...intl,customsInvoice:{reasonForExport:'Sale',products:[{...product,hsCode:''}]}}})).status,400);
 assert.equal((await invoke(controller.bookShipment,{body:{...intl,customsInvoice:{reasonForExport:'Sale',taxType:'HST',products:[product]}}})).status,400);
 let saved;stub(carrier,'getRates',async()=>[raw]);stub(Shipment,'create',async data=>{saved=data;return new Shipment(data)});
 assert.equal((await invoke(controller.bookShipment,{body:{...intl,customsInvoice:{reasonForExport:'Gift',products:[product]}}})).status,201);assert.equal(saved.customsInvoice.reasonForExport,'Gift');
 const client=fs.readFileSync('../frontend/src/app/booking/BookingClient.tsx','utf8');assert.match(client,/reasonForExport,/);assert.doesNotMatch(client,/section232/);
});
test('package inputs accept two decimals and volumetric weight uses one factor in both unit systems',()=>{
 for(const file of ['../frontend/src/app/quote/_components/PackageDetailsSection.tsx','../frontend/src/app/booking/_components/ShipmentDetailsStep.tsx']){
  const s=fs.readFileSync(file,'utf8');assert.doesNotMatch(s,/min="1" step="0\.1"/,file);assert.doesNotMatch(s,/5000 : 166/,file);assert.match(s,/volumetricWeight\(/,file);
 }
 assert.match(fs.readFileSync('../frontend/src/lib/dim-weight.ts','utf8'),/cm: 5000, in: 139/);
 assert.ok(Math.abs(5000/16.387064/2.20462262-139)/139<0.005,'5000 cm3/kg and 139 in3/lb must describe the same density');
});
test('signed-in requests with malformed shipment IDs get 400 on every customer route, never reaching the database',async()=>{
 const express=require('express'),jwt=require('jsonwebtoken'),router=require('../dist/routes').default;const app=express();app.use(express.json());app.use('/api',router);app.use(errorHandler);
 stub(Shipment,'findById',()=>assert.fail('invalid ID reached database'));
 const auth={authorization:'Bearer '+jwt.sign({userId:owner,role:'customer'},process.env.JWT_SECRET||'fallback_secret'),'content-type':'application/json'};
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 try{const base=`http://127.0.0.1:${server.address().port}/api/shipments/not-an-id`;
  for(const [method,path,body] of [['GET','/label'],['GET','/invoice'],['POST','/cancel','{}'],['POST','/confirm-payment','{"method":"stripe","transactionId":"pi_x"}']]){
   const r=await fetch(base+path,{method,headers:auth,body});assert.equal(r.status,400,method+' '+path);assert.doesNotMatch(JSON.stringify(await r.json()),/Cast to ObjectId|stack/,path)}
 }finally{await new Promise(resolve=>server.close(resolve))}
});
function historyQuery(){const calls={};stub(Shipment,'countDocuments',async()=>0);stub(Shipment,'find',q=>{calls.query=q;const chain={sort(s){calls.sort=s;return chain},skip(){return chain},limit(){return chain},lean:async()=>[]};return chain});return calls}
test('shipment history applies Include Cancelled and every sort order on the server',async()=>{
 let c=historyQuery();assert.equal((await invoke(controller.getMyShipments,{query:{excludeStatus:'cancelled'}})).status,200);assert.deepEqual(c.query.status,{$ne:'cancelled'});assert.deepEqual(c.sort,{createdAt:-1});
 c=historyQuery();await invoke(controller.getMyShipments,{query:{sortBy:'createdAt_asc'}});assert.deepEqual(c.sort,{createdAt:1});assert.equal(c.query.status,undefined);
 c=historyQuery();await invoke(controller.getMyShipments,{query:{sortBy:'amount_desc'}});assert.deepEqual(c.sort,{'payment.amount':-1,createdAt:-1});
 c=historyQuery();await invoke(controller.getMyShipments,{query:{sortBy:'amount_asc',status:'cancelled',excludeStatus:'cancelled'}});assert.deepEqual(c.sort,{'payment.amount':1,createdAt:-1});assert.equal(c.query.status,'cancelled');
 c=historyQuery();await invoke(controller.getMyShipments,{query:{sortBy:'password',status:{$ne:'x'}}});assert.deepEqual(c.sort,{createdAt:-1});assert.equal(c.query.status,undefined);
 const page=fs.readFileSync('../frontend/src/app/account/shipments/page.tsx','utf8');assert.match(page,/\n\s+sortBy,\r?\n/);assert.doesNotMatch(page,/list\].sort\(/);
});
test('recipient confirmation e-mail follows the booking choice',async()=>{
 let sent;stub(carrier,'createShipment',async p=>{sent=p;return{order_id:1,documents:[]}});
 const s=document();s.recipient.email='recipient@example.com';await controller.generateLabelForShipment(s);assert.equal(sent.ship.destination.send_email_confirmation,true);
 s.notifyRecipient=false;await controller.generateLabelForShipment(s);assert.equal(sent.ship.destination.send_email_confirmation,false);
 let saved;stub(carrier,'getRates',async()=>[raw]);stub(Shipment,'create',async data=>{saved=data;return new Shipment(data)});
 await invoke(controller.bookShipment,{body:{...booking,notifyRecipient:false}});assert.equal(saved.notifyRecipient,false);
 await invoke(controller.bookShipment,{body:booking});assert.equal(saved.notifyRecipient,true);
});
test('booking form has no controls that report success or do nothing',()=>{
 const step=fs.readFileSync('../frontend/src/app/booking/_components/ShipmentDetailsStep.tsx','utf8'),panel=fs.readFileSync('../frontend/src/app/booking/_components/AddressPanel.tsx','utf8');
 assert.doesNotMatch(step,/saved as draft/);assert.match(step,/onClick=\{handleSaveDraft\}/);
 for(const [name,src] of [['ShipmentDetailsStep',step],['AddressPanel',panel]])for(const box of src.match(/<input type="checkbox"[^>]*>/g))assert.match(box,/checked=\{/,name+': '+box);
 for(const field of panel.match(/<input\b[^>]*>/g))assert.match(field,/value=|checked=/,'AddressPanel input without state: '+field);
 const client=fs.readFileSync('../frontend/src/app/booking/BookingClient.tsx','utf8');assert.match(client,/authApi\.addAddress\(/);assert.match(client,/notifyRecipient,\r?\n/);assert.match(client,/writeLocal\(pickupPrefKey/);
});
test('contact form emails support with escaped content and reply-to, and reports delivery failure',async()=>{
 const contact=require('../dist/controllers/contact.controller'),emails=require('../dist/services/email.service').default;
 let mail;stub(emails.transporter,'sendMail',async m=>{mail=m});
 const body={name:'Ann <b>',email:'ann@example.com',subject:'Hi\r\nBcc: x@evil.test',message:'<script>x</script>'};
 let r=await invoke(contact.submitContact,{body});assert.equal(r.status,200);
 assert.equal(mail.to,process.env.CONTACT_EMAIL||'support@pilotcourier.com');assert.deepEqual(mail.replyTo,{name:'Ann <b>',address:'ann@example.com'});
 assert.equal(mail.subject,'Contact form: Hi Bcc: x@evil.test');assert.doesNotMatch(mail.html,/<script>|<b>/);assert.match(mail.html,/&lt;script&gt;x&lt;\/script&gt;/);
 for(const bad of [{...body,email:'nope'},{...body,message:''},{...body,name:'  '},{...body,subject:undefined}])assert.equal((await invoke(contact.submitContact,{body:bad})).status,400);
 mail=undefined;assert.equal((await invoke(contact.submitContact,{body:{...body,website:'http://spam.example'}})).status,200);assert.equal(mail,undefined);
 stub(emails.transporter,'sendMail',async()=>{throw Error('smtp down')});r=await invoke(contact.submitContact,{body});assert.equal(r.status,502);assert.equal(r.data.success,false);
});
test('newsletter stores each address once and answers the same for repeats and bots',async()=>{
 const contact=require('../dist/controllers/contact.controller'),Subscriber=require('../dist/models/NewsletterSubscriber').default;
 const calls=[];stub(Subscriber,'updateOne',async(...a)=>{calls.push(a);return{}});
 assert.equal((await invoke(contact.subscribeNewsletter,{body:{email:'  New@Example.COM '}})).status,200);
 assert.deepEqual(calls[0],[{email:'new@example.com'},{$setOnInsert:{email:'new@example.com',source:'footer'}},{upsert:true}]);
 stub(Subscriber,'updateOne',async()=>{throw Object.assign(Error('duplicate'),{code:11000})});assert.equal((await invoke(contact.subscribeNewsletter,{body:{email:'new@example.com'}})).status,200);
 stub(Subscriber,'updateOne',()=>assert.fail('database'));
 assert.equal((await invoke(contact.subscribeNewsletter,{body:{email:'not-an-email'}})).status,400);
 assert.equal((await invoke(contact.subscribeNewsletter,{body:{email:'bot@example.com',website:'x'}})).status,200);
});
test('contact and newsletter routes are public and rate limited; subscriber list is admin-only',async()=>{
 const express=require('express'),jwt=require('jsonwebtoken'),router=require('../dist/routes').default,Subscriber=require('../dist/models/NewsletterSubscriber').default;
 stub(Subscriber,'updateOne',async()=>({}));stub(Subscriber,'find',()=>assert.fail('non-admin reached subscriber list'));
 const app=express();app.use(express.json());app.use('/api',router);app.use(errorHandler);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 try{const base=`http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await fetch(base+'/admin/newsletter')).status,401);
  assert.equal((await fetch(base+'/admin/newsletter',{headers:{authorization:'Bearer '+jwt.sign({userId:owner,role:'customer'},process.env.JWT_SECRET||'fallback_secret')}})).status,403);
  const statuses=[];for(let i=0;i<11;i++)statuses.push((await fetch(base+'/newsletter/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`n${i}@example.com`})})).status);
  assert.deepEqual(statuses,[...Array(10).fill(200),429]);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
test('contact and newsletter forms submit to the API instead of faking success',()=>{
 const c=fs.readFileSync('../frontend/src/app/contact/ContactClient.tsx','utf8'),f=fs.readFileSync('../frontend/src/components/layout/Footer.tsx','utf8');
 assert.doesNotMatch(c,/setTimeout/);assert.match(c,/formsApi\.contact\(/);assert.doesNotMatch(f,/onSubmit=\{e => e\.preventDefault\(\)\}/);assert.match(f,/formsApi\.subscribe\(/);
});
test('pickup date is sent to netParcel as ship_date; past or malformed dates are left out',async()=>{
 let payload;stub(carrier,'getRates',async p=>{payload=p;return[raw]});
 const future=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
 assert.equal((await invoke(controller.getRates,{body:{...quote,pickupMethod:'schedule_pickup',pickupDate:future}})).status,200);assert.equal(payload.rate.ship_date,future);
 for(const bad of ['2020-01-01','01/10/2026','2026-13-45','not-a-date',undefined]){assert.equal((await invoke(controller.getRates,{body:{...quote,pickupDate:bad}})).status,200);assert.equal('ship_date' in payload.rate,false,String(bad))}
});
test('booking re-rates with the same pickup date as the quote',async()=>{
 const future=new Date(Date.now()+3*86400000).toISOString().slice(0,10);let payload;
 stub(carrier,'getRates',async p=>{payload=p;return[raw]});stub(Shipment,'create',async d=>new Shipment(d));
 const r=await invoke(controller.bookShipment,{body:{...booking,pickupDetails:{method:'schedule_pickup',pickupDate:future,location:'Reception',readyHour:'10',readyMin:'00',closeHour:'14',closeMin:'00'}}});
 assert.equal(r.status,201);assert.equal(payload.rate.ship_date,future);
});
test('envelope is rated and shipped as one envelope at the netParcel limit, not the hidden package row',async()=>{
 let payload;stub(carrier,'getRates',async p=>{payload=p;return[raw]});
 await invoke(controller.getRates,{body:{...quote,packagingType:'Envelope',weightUnit:'kg',dimensionUnit:'cm',packages:[{...parcel,length:1,width:1,height:1,weight:1},{...parcel,weight:3}]}});
 assert.deepEqual(payload.rate.packaging_information.packages.map(p=>[p.length,p.width,p.height,p.weight]),[[1,1,1,0.45]]);assert.equal(payload.rate.items[0].weight,0.45);
 await invoke(controller.getRates,{body:{...quote,packagingType:'Envelope',packages:[{...parcel,weight:5}]}});
 assert.deepEqual(payload.rate.packaging_information.packages.map(p=>p.weight),[1]);
 assert.deepEqual(carrier.buildPackagingInformation([{...parcel,weightUnit:'kg',dimensionUnit:'cm',weight:1}],'Envelope').packages.map(p=>[p.length,p.width,p.height,p.weight]),[[1,1,1,0.45]]);
 await invoke(controller.getRates,{body:{...quote,packagingType:'My Packaging',packages:[{...parcel,weight:5}]}});assert.equal(payload.rate.packaging_information.packages[0].weight,5);
 const client=fs.readFileSync('../frontend/src/app/booking/BookingClient.tsx','utf8');assert.match(client,/ENVELOPE_MAX_WEIGHT\[dimUnit\]/);assert.match(client,/pickupMethod,\r?\n\s+pickupDate,/);assert.match(client,/const pkgList = quotedPackages\(\)/);
});
test('P.O. Box addresses are refused before netParcel is called, at pickup and delivery',async()=>{
 stub(carrier,'getRates',()=>assert.fail('carrier'));
 for(const [side,street] of [['destination','PO Box 1200'],['destination','P.O. Box 55'],['origin','Post Office Box 9'],['destination','Case postale 12'],['destination','C.P. 45'],['destination','General Delivery'],['origin','Box 77']]){
  const r=await invoke(controller.getRates,{body:{...quote,[side+'Street']:street}});assert.equal(r.status,400,street);assert.match(r.data.message,/P\.O\. Box/,street);
 }
 stub(carrier,'getRates',async()=>[raw]);
 for(const street of ['10 Boxwood Dr','290 Bremner Blvd','1 Post Rd','5100 Spectrum Way'])assert.equal((await invoke(controller.getRates,{body:{...quote,destinationStreet:street}})).status,200,street);
});
test('Canadian postal code must belong to the chosen province',async()=>{
 stub(carrier,'getRates',()=>assert.fail('carrier'));
 const r=await invoke(controller.getRates,{body:{...quote,destinationProvince:'ON'}});assert.equal(r.status,400);assert.match(r.data.message,/V6B1A1 belongs to BC, not ON/);
 stub(carrier,'getRates',async()=>[raw]);
 for(const prov of ['BC','British Columbia','',undefined])assert.equal((await invoke(controller.getRates,{body:{...quote,destinationProvince:prov}})).status,200,String(prov));
 assert.equal((await invoke(controller.getRates,{body:{...quote,destinationPostal:'X0A0H0',destinationCity:'Iqaluit',destinationProvince:'NU'}})).status,200);
});
test('Hold for Pickup without a signature drops Purolator with a notice; with a signature Purolator stays',async()=>{
 const puro={...raw,service_code:'2001',service_name:'Purolator Express Pack'},cp={...raw,service_code:'140001',service_name:'Canada Post Expedited Parcel'};
 stub(carrier,'getRates',async()=>[puro,cp]);
 let r=await invoke(controller.getRates,{body:{...quote,specialServices:{holdForPickup:true}}});
 assert.equal(r.status,200);assert.deepEqual(r.data.rates.map(x=>x.serviceName),['Canada Post Expedited Parcel']);assert.match(r.data.notice,/Purolator is not available with Hold for Pickup/);
 for(const s of [{holdForPickup:true,signatureRequired:true},{holdForPickup:true,adultSignature:true},{}]){r=await invoke(controller.getRates,{body:{...quote,specialServices:s}});assert.equal(r.data.rates.length,2,JSON.stringify(s));assert.equal(r.data.notice,undefined)}
 stub(Shipment,'create',()=>assert.fail('database'));
 r=await invoke(controller.bookShipment,{body:{...booking,specialServices:{holdForPickup:true},selectedRate:{...rate,serviceCode:'2001',carrierId:'2001',serviceName:'Purolator Express Pack'}}});assert.equal(r.status,409);
 stub(carrier,'getRates',async()=>[puro]);r=await invoke(controller.getRates,{body:{...quote,specialServices:{holdForPickup:true}}});assert.equal(r.status,422);assert.match(r.data.message,/require a signature or turn off Hold for Pickup/);
 assert.match(fs.readFileSync('../frontend/src/app/booking/BookingClient.tsx','utf8'),/if \(data\.notice\) toast\(data\.notice/);
});
test('database casting errors have safe response',()=>{let response;errorHandler(Object.assign(new Error('Cast to ObjectId failed secret'),{name:'CastError'}),{method:'GET',path:'/'},{status(n){assert.equal(n,400);return this},json(v){response=v}},()=>{});assert.deepEqual(response,{success:false,message:'Invalid identifier.'})});
test('invoice endpoint returns actual PDF without fetching a label',async()=>{const s=document();s.payment.status='completed';s.createdAt=new Date('2026-09-28');stub(Shipment,'findById',async()=>s);stub(carrier,'getOrder',()=>assert.fail('label fetch'));const r=await invoke(downloadInvoice);assert.equal(r.status,200);assert.match(r.data.invoice,/^data:application\/pdf;base64,/);const pdf=Buffer.from(r.data.invoice.split(',')[1],'base64');assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.includes(Buffer.from('Invoice NPI')));assert.equal(r.data.label,undefined)});
test('invoice requires owner and completed payment',async()=>{stub(Shipment,'findById',async()=>document());assert.equal((await invoke(downloadInvoice)).status,409);assert.equal((await invoke(downloadInvoice,{user:{userId:'other'}})).status,403)});
test('frontend/backend postal rules stay identical',()=>assert.equal(fs.readFileSync('src/utils/postal.ts','utf8'),fs.readFileSync('../frontend/src/lib/postal.ts','utf8')));
test('all 70 sampled countries have subdivision options and invalid codes make no requests',async()=>{const fixtures=require('./fixtures/postal-70-country.json').fixtures;const subdivisions=require('../src/data/subdivisions.json');stub(global,'fetch',()=>assert.fail('invalid postal reached provider'));for(const country of new Set(fixtures.map(f=>f.country))){assert.ok(subdivisions.find(c=>c.code===country)?.states.length,country);for(const code of ['ABCD','!123','1','123456789012345678901234567890123']){assert.equal(postal.isPostalLookupReady(country,code),false,country+' '+code);assert.deepEqual(await lookupPostal(country,code),{city:'',province:''})}}});
test('no-postal countries accept blank form values without lookups',()=>{for(const country of ['AE','HK','QA']){assert.equal(postal.isPostalFormatValid(country,''),true);assert.equal(postal.isPostalLookupReady(country,''),false);assert.equal(postal.isPostalLookupReady(country,'1234'),false)}});
test('Quick Quote handling label and booking packaging are wired',()=>{const quick=fs.readFileSync('../frontend/src/app/quote/_components/PackageDetailsSection.tsx','utf8');assert.match(quick,/Special handling/i);assert.doesNotMatch(quick,/>Signature</);const booking=fs.readFileSync('../frontend/src/app/booking/BookingClient.tsx','utf8');const section=booking.slice(booking.indexOf('const handleGetQuote'),booking.indexOf('const handleBook'));assert.match(section,/packagingType/);assert.match(section,/freightClass/)});
test('all replay province codes resolve to named dropdown options',()=>{const subdivisions=require('../src/data/subdivisions.json');for(const row of require('./fixtures/postal-70-country.json').fixtures){if(row.expected.province)assert.ok(subdivisions.find(c=>c.code===row.country).states.some(s=>s.state_code===row.expected.province),row.country+' '+row.expected.province)}});
test('currency minor units preserve CAD/USD and zero-decimal currencies',()=>{assert.equal(payment.toMinorUnits(600,'CAD'),60000);assert.equal(payment.toMinorUnits(10.99,'EUR'),1099);assert.equal(payment.toMinorUnits(600,'JPY'),600);assert.equal(payment.toMinorUnits(5,'ISK'),500);assert.throws(()=>payment.toMinorUnits(5.5,'ISK'));assert.throws(()=>payment.toMinorUnits(1.001,'USD'));assert.equal(payment.paypalAmount(600,'JPY'),'600');assert.throws(()=>payment.paypalAmount(1.5,'JPY'))});
test('Stripe checkout binds provider intent before returning secret and authoritative amount',async()=>{
 const s=document();s.payment.stripeIntentId=undefined;let bound,options;
 stub(Shipment,'findById',async()=>s);stub(Shipment,'findOneAndUpdate',async()=>s);
 stub(payment.stripe.paymentIntents,'create',async (payload,opts)=>{assert.equal(payload.amount,60000);assert.equal(payload.metadata.userId,owner);options=opts;return{id:'pi_created',client_secret:'test-secret'}});
 stub(Shipment,'updateOne',async(filter,update)=>{bound=update.$set['payment.stripeIntentId'];return{matchedCount:1}});
 const r=await invoke(payments.createStripeIntent,{body:{shipmentId:id,amount:0.01}});assert.equal(r.status,200);assert.equal(bound,'pi_created');assert.equal(r.data.amount,600);assert.equal(r.data.currency,'CAD');assert.equal(options.idempotencyKey,`shipment-${id}-stripe`);
});
test('unverified legacy bookings cannot create payable intents',async()=>{const s=document();s.payment.priceVerified=false;stub(Shipment,'findById',async()=>s);stub(payment.stripe.paymentIntents,'create',()=>assert.fail('Stripe'));assert.equal((await invoke(payments.createStripeIntent,{body:{shipmentId:id}})).status,409)});
test('Stripe webhook verifies signature before database access',async()=>{stub(payment.stripe.webhooks,'constructEvent',()=>{throw Error('bad signature')});stub(Shipment,'findById',()=>assert.fail('database'));const r=await invoke(payments.stripeWebhook);assert.equal(r.status,400);assert.doesNotMatch(r.data.message,/stack|secret/)});
test('verified webhook shares completion path and rejects mismatched amounts',async()=>{
 const s=document();let eventIntent=intent();stub(payment.stripe.webhooks,'constructEvent',()=>({type:'payment_intent.succeeded',data:{object:eventIntent}}));stub(Shipment,'findById',async()=>s);let claims=0;
 stub(Shipment,'findOneAndUpdate',async()=>{claims++;s.payment.status='completed';s.payment.transactionId='pi_test';return s});stub(s,'save',async()=>s);stub(carrier,'createShipment',async()=>({order_id:100,documents:[]}));
 eventIntent={...intent(),amount_received:1};assert.equal((await invoke(payments.stripeWebhook)).status,500);assert.equal(claims,0);eventIntent=intent();assert.equal((await invoke(payments.stripeWebhook)).status,200);assert.equal(claims,1);
});
test('PayPal pre-capture verification refuses wrong amount before charging',async()=>{const s=document();stub(Shipment,'findById',async()=>s);let captures=0;stub(axios,'post',async url=>{if(url.endsWith('/token'))return{data:{access_token:'test'}};captures++;throw Error('unexpected capture')});const order=paypal();order.status='APPROVED';order.purchase_units[0].amount.value='0.01';stub(axios,'get',async()=>({data:order}));assert.equal((await invoke(payments.capturePayPalOrder,{body:{shipmentId:id,orderId:'PPTEST'}})).status,400);assert.equal(captures,0)});
test('province HTTP route covers 70 countries and payment and cancel routes require authentication',async()=>{
 const express=require('express'),router=require('../dist/routes').default;const app=express();app.use(express.json());app.use('/api',router);app.use(errorHandler);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 try{const base=`http://127.0.0.1:${server.address().port}/api`;for(const code of new Set(require('./fixtures/postal-70-country.json').fixtures.map(f=>f.country))){const r=await fetch(`${base}/geo/provinces?country=${code}`);assert.equal(r.status,200);const options=await r.json();assert.ok(options.length,code);assert.ok(options.every(o=>o.label&&o.value))}
 for(const path of ['/shipments/book',`/shipments/${id}/confirm-payment`,`/shipments/${id}/cancel`,'/payments/stripe/intent','/payments/paypal/order','/payments/paypal/capture']){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,401,path)}
 }finally{await new Promise(resolve=>server.close(resolve))}
});
for(const packagingType of ['My Packaging','Envelope','Pak','Pallet'])test(`quote and booking retain ${packagingType} with metric units`,async()=>{
 const metric={...parcel,weightUnit:'kg',dimensionUnit:'cm'};let quoted,sent;stub(carrier,'getRates',async p=>{quoted=p;return[raw]});stub(carrier,'createShipment',async p=>{sent=p;return{order_id:1,documents:[]}});
 assert.equal((await invoke(controller.getRates,{body:{...quote,packagingType,weightUnit:'kg',dimensionUnit:'cm',packages:[metric]}})).status,200);const s=document();s.parcels=[metric];s.packagingType=packagingType;await controller.generateLabelForShipment(s);assert.deepEqual(sent.ship.packaging_information,quoted.rate.packaging_information);
});
test('carrier HTTP validation errors retain the actual package limit',async()=>{stub(carrier.client,'post',async()=>{throw{response:{status:422,data:{errors:[{errorMessage:'Weight exceeds carrier limit.'}]}}}});const r=await invoke(controller.getRates,{body:quote});assert.equal(r.status,422);assert.match(r.data.message,/Weight exceeds carrier limit/)});
test('Stripe does not expose a payment secret when booking was cancelled during intent creation',async()=>{const s=document();s.payment.stripeIntentId=undefined;stub(Shipment,'findById',async()=>s);stub(Shipment,'findOneAndUpdate',async()=>s);stub(payment.stripe.paymentIntents,'create',async()=>({id:'pi_new',client_secret:'must-not-return'}));stub(Shipment,'updateOne',async()=>({matchedCount:0}));const r=await invoke(payments.createStripeIntent,{body:{shipmentId:id}});assert.equal(r.status,409);assert.equal(r.data.clientSecret,undefined)});
