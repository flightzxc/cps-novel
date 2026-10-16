import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const req=createRequire('/app/package.json');const {PrismaClient}=req('@prisma/client');const db=new PrismaClient();
async function main(){
 const meta=JSON.parse(readFileSync('/app/.build-metadata.json','utf8'));if(process.cwd()!='/app'||meta.commit!=='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'||meta.version!=='0.6.1')throw Error('production_identity_mismatch');
 const ids=JSON.parse(readFileSync('/tmp/v061-source-item-ids.json','utf8'));if(ids.length!==34||new Set(ids).size!==34)throw Error('source_scope_invalid');
 const x=await db.$transaction(async(tx:any)=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const [role]=await tx.$queryRawUnsafe("SELECT current_user::text role,current_database()::text db,current_setting('transaction_read_only') readonly");if(role.role!=='worker_app'||role.db!=='cps_novel'||role.readonly!=='on')throw Error('role_refused');
  const rows=await tx.$queryRawUnsafe(`SELECT s.id AS "sourceItemId",s.channel_app_id AS "channelAppId",sa.code AS "appCode",s.status AS "sourceStatus",s.novel_id AS "novelId",n.status AS "novelStatus",
   (SELECT count(*)::int FROM novel_chapter c JOIN novel_chapter_content cc ON cc.novel_chapter_id=c.id WHERE c.novel_id=n.id AND c.deleted_at IS NULL AND c.status='preview' AND btrim(cc.body)<>'') AS "readableChapters",
   (SELECT count(*)::int FROM channel_sync_task_item i JOIN channel_sync_task t ON t.id=i.task_id WHERE i.novel_source_item_id=s.id AND t.task_type='moboreader.preview_refresh.v1' AND (i.status IN ('pending','processing') OR t.status IN ('pending','processing'))) AS "inflightPreview"
   FROM novel_source_item s JOIN novel n ON n.id=s.novel_id JOIN channel_app ca ON ca.id=s.channel_app_id JOIN source_app sa ON sa.id=ca.source_app_id WHERE s.id=ANY($1::uuid[]) AND s.deleted_at IS NULL AND n.deleted_at IS NULL ORDER BY sa.code,s.channel_app_id,s.id`,ids);
  if(rows.length!==34||rows.some((r:any)=>!ids.includes(r.sourceItemId)))throw Error('source_scope_changed');
  return {at:new Date().toISOString(),databaseRole:role.role,transactionReadOnly:role.readonly,rows};
 },{isolationLevel:'RepeatableRead',timeout:120000});console.log(JSON.stringify(x));
}
main().catch(()=>{console.error(JSON.stringify({status:'STOP',code:'group_preview_failed'}));process.exitCode=1}).finally(()=>db.$disconnect());
