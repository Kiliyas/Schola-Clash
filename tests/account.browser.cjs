const assert = require('node:assert/strict');
const {chromium}=require('playwright');
const {liveFixtures,installSupabaseStub,assertLayout}=require('./profiles.browser.cjs');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
 for(const width of [1440,390,320]) {
 const context=await browser.newContext({viewport:{width,height:900}});
 const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const fixture=liveFixtures('student');fixture.role='signed-out';
 await context.addInitScript(installSupabaseStub,fixture);
 await context.addInitScript(()=>{
 const original=window.supabase.createClient;
 window.supabase.createClient=()=>{
 const client=original();window.__accountCalls=[];let failReset=true,failName=true;
 client.auth.resetPasswordForEmail=async(email,options)=>{
 window.__accountCalls.push({email,options});
 if(failReset){failReset=false;return {error:{status:500,message:'database failure'}};}
 return {error:null};};
 client.auth.updateUser=async(args)=>{window.__accountCalls.push(args);return {error:null};};
 const subscribe=client.auth.onAuthStateChange;
 client.auth.onAuthStateChange=(cb)=>{window.__recover=async()=>{await client.auth.signInWithPassword({email:'student@example.com'});cb('PASSWORD_RECOVERY',{user:{id:'student-live'}});};return subscribe(cb);};
 const from=client.from;
 client.from=(table)=>{
 const q=from(table);
 if(table==='user_profiles') q.update=(values)=>{
 const updateQuery={eq(key,id){window.__accountCalls.push({values,key,id});return updateQuery;},select(){return updateQuery;},async single(){if(failName){failName=false;return {error:{status:500}};}return {data:{display_name:values.display_name,role:'student'},error:null};}};
 return updateQuery;
 };
 return q;};return client;
 };
 });
 await page.route('**/*',r=>{
 const u=new URL(r.request().url());
 if(u.hostname==='cdn.jsdelivr.net')return r.fulfill({body:'/* fixture */',contentType:'application/javascript'});
 if(u.pathname==='/supabase/client-config.js')return r.fulfill({body:'window.SCHOLA_SUPABASE_CONFIG={url:"https://test.invalid",publishableKey:"test"}',contentType:'application/javascript'});
 if(u.hostname==='127.0.0.1')return r.fulfill({body:require('node:fs').readFileSync(require('node:path').join(__dirname,'..',u.pathname==='/'?'index.html':u.pathname)),contentType:u.pathname.endsWith('.js')?'application/javascript':u.pathname.endsWith('.css')?'text/css':'text/html'});return r.abort();});
 await page.goto('http://127.0.0.1:8000');
 await page.locator('#authEmail').fill('student@example.com');await page.locator('#forgotPassword').click();
 assert.equal(await page.locator('#authEmail').inputValue(),'student@example.com');
 await page.locator('[type=submit]').click();await page.getByText("We couldn't send the reset link. Please try again.",{exact:true}).waitFor();
 await page.locator('[type=submit]').click();await page.getByText(/If an account exists/).waitFor();
 const call=await page.evaluate(()=>window.__accountCalls[1]);assert.equal(call.options.redirectTo,'http://127.0.0.1:8000/');
 await page.evaluate(()=>window.__recover());await page.locator('#passwordForm').waitFor();
 await page.locator('#newPassword').fill('newPassword123');await page.locator('#confirmPassword').fill('different123');await page.locator('[type=submit]').click();await page.getByText('Passwords do not match.').waitFor();
 await page.locator('#confirmPassword').fill('newPassword123');await page.locator('[type=submit]').click();await page.locator('#accountButton').waitFor({state:'visible'});
 await page.locator('#accountButton').click();await page.locator('#displayName').fill('   ');await page.locator('#accountForm [type=submit]').click();await page.getByText('Enter your name.',{exact:true}).waitFor();
 await page.locator('#displayName').fill('  Updated Student  ');await page.locator('#accountForm [type=submit]').click();await page.getByText('Could not save your name. Please try again.',{exact:true}).waitFor();
 await page.locator('#accountForm [type=submit]').click();await page.getByRole('heading',{name:'Welcome, Updated Student'}).waitFor();
 await page.locator('#accountButton').click();assert.equal(await page.locator('#displayName').inputValue(),'Updated Student');await assertLayout(page,'account-'+width,true);
 await page.getByRole('button',{name:'Close',exact:true}).click();await assertLayout(page,'account-'+width);
 assert.deepEqual(errors,[]);console.log('PASS account '+width);await context.close();
 }

 for(const role of ['teacher','student']) {
 const context=await browser.newContext({viewport:{width:390,height:900}}),page=await context.newPage();
 const fixture=liveFixtures(role);fixture.tables.teacher_streams=[];fixture.tables.classrooms=[];fixture.tables.class_members=[];
 await context.addInitScript(installSupabaseStub,fixture);
 await context.addInitScript(({role,tables})=>{
 window.__workflowRows=async(table)=>tables[table];
 const original=window.supabase.createClient;
 window.supabase.createClient=()=>{const client=original();const rpc=client.rpc;
 client.rpc=async(name,args)=>{
 if(name==='create_teacher_space') {tables.teacher_streams=[{id:'new-stream',name:args.p_name,owner_user_id:'teacher-live'}];tables.classrooms=args.p_class_names.map((name,i)=>({id:'new-class-'+i,name,stream_id:'new-stream'}));return {error:null};}
 if(name==='join_class_by_code') {
 window.__joinCalls=(window.__joinCalls||0)+1;
 if(window.__joinCalls===1)return {error:{message:'This class code is invalid or expired.'}};
 tables.teacher_streams=[{id:'new-stream',name:'History',owner_user_id:'teacher-live'}];tables.classrooms=[{id:'new-class',name:'Grade 7',stream_id:'new-stream'}];tables.class_members=[{class_id:'new-class',user_id:'student-live',classrooms:tables.classrooms[0]}];return {data:{class_name:'Grade 7',status:'joined'},error:null};
 }
 if(name==='get_teacher_chapter_progress')return {data:[],error:null};
 return rpc(name,args);};return client;};
 },{role,tables:fixture.tables});
 await page.route('**/*',r=>{const u=new URL(r.request().url());if(u.hostname==='cdn.jsdelivr.net')return r.fulfill({body:'',contentType:'application/javascript'});if(u.pathname==='/supabase/client-config.js')return r.fulfill({body:'window.SCHOLA_SUPABASE_CONFIG={url:"https://test.invalid",publishableKey:"test"}',contentType:'application/javascript'});return r.fulfill({body:require('node:fs').readFileSync(require('node:path').join(__dirname,'..',u.pathname==='/'?'index.html':u.pathname)),contentType:u.pathname.endsWith('.js')?'application/javascript':u.pathname.endsWith('.css')?'text/css':'text/html'});});
 await page.goto('http://127.0.0.1:8000');
 if(role==='teacher'){
 await page.locator('#liveCreateStream').click();await page.locator('#liveStreamName').fill('My teaching space');await page.locator('#liveClassNames').fill('Grade 7');await page.locator('#liveSaveStream').click();await page.locator('[data-live-tab="classes"]').click();await page.getByRole('heading',{name:'Grade 7'}).waitFor();
 }else{
 await page.locator('#liveJoinFirst').click();await page.locator('#liveJoinCode').fill('short');await page.locator('#liveJoinForm [type=submit]').click();await page.getByText('Enter the 12-character class code from your teacher.',{exact:true}).waitFor();
 await page.locator('#liveJoinCode').fill('a1b2 c3d4 e5f6');await page.locator('#liveJoinForm [type=submit]').click();await page.getByText('This class code is invalid or expired.',{exact:true}).waitFor();await page.locator('#liveJoinForm [type=submit]').click();await page.locator('.rating-overview').waitFor();assert.equal(await page.locator('#liveJoinFirst').count(),0);
 }
 console.log('PASS first-entry '+role);await context.close();
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
