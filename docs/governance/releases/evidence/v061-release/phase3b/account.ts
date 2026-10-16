import {createRequire} from 'node:module';import fs from 'node:fs';
const req=createRequire('/app/package.json'),{PrismaClient}=req('@prisma/client'),db=new PrismaClient();
async function main(){const meta=JSON.parse(fs.readFileSync('/app/.build-metadata.json','utf8'));if(process.cwd()!='/app'||meta.commit!=='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'||meta.version!=='0.6.1')throw Error('identity');
 const input=JSON.parse(fs.readFileSync('/tmp/v061-account-input.json','utf8'));
 const x=await db.$transaction(async(tx:any)=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');const [role]=await tx.$queryRawUnsafe("SELECT current_user::text role,current_setting('transaction_read_only') readonly");if(role.role!=='worker_app'||role.readonly!=='on')throw Error('role');
 const articles=await tx.article.findMany({where:{novelId:{in:input.novelIds},deletedAt:null},select:{id:true,novelId:true,status:true,publishedAt:true}});
 const previews=await tx.$queryRawUnsafe(`SELECT i.id AS "itemId",i.novel_source_item_id AS "sourceItemId",s.novel_id AS "novelId",i.task_id AS "taskId",i.status,i.attempt_count AS "attemptCount",i.finished_at AS "finishedAt",
 CASE WHEN i.result->>'reason' ~ '^[A-Za-z0-9_.:-]{1,160}$' THEN i.result->>'reason' END AS reason,
 CASE WHEN i.error->>'kind' ~ '^[A-Za-z0-9_.:-]{1,160}$' THEN i.error->>'kind' END AS "failureKind",
 CASE WHEN i.error->>'code' ~ '^[A-Za-z0-9_.:-]{1,160}$' THEN i.error->>'code' END AS "failureCode",
 COALESCE((i.result->>'contentWrites')::int,0) AS "contentWrites",COALESCE((i.result->>'materializedCount')::int,0) AS "materializedCount",COALESCE((i.result->>'preservedCount')::int,0) AS "preservedCount",COALESCE((i.result->>'restoredCount')::int,0) AS "restoredCount",COALESCE((i.result->>'staleCount')::int,0) AS "staleCount",i.result->'emptyChapterNumbers' AS "emptyChapterNumbers"
 FROM channel_sync_task_item i JOIN channel_sync_task t ON t.id=i.task_id JOIN novel_source_item s ON s.id=i.novel_source_item_id WHERE t.task_type='moboreader.preview_refresh.v1' AND t.mode='apply' AND i.created_at >= $1::timestamptz AND (s.novel_id=ANY($2::uuid[]) OR s.id=ANY($3::uuid[])) ORDER BY s.id,i.created_at`,input.since,input.novelIds,input.sourceItemIds);
 const taskIds=[...new Set(previews.map((i:any)=>i.taskId))];const tasks=taskIds.length?await tx.$queryRawUnsafe(`SELECT id,status,completed_at AS "completedAt",result->'sitemapRefresh' AS "sitemapRefresh" FROM channel_sync_task WHERE id=ANY($1::uuid[]) ORDER BY id`,taskIds):[];
 const refreshIds=[...new Set(tasks.map((t:any)=>t.sitemapRefresh?.taskId).filter(Boolean))];const refreshes=refreshIds.length?await tx.genericTask.findMany({where:{id:{in:refreshIds}},select:{id:true,status:true,params:true,completedAt:true}}):[];
 const latest=await tx.genericTask.findFirst({where:{taskType:'sitemap_refresh'},orderBy:{createdAt:'desc'},select:{id:true,status:true,params:true,createdAt:true,completedAt:true}});
 const totals=await tx.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE p.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND a.status='published' AND a.deleted_at IS NULL) AS published,
 (SELECT count(*)::int FROM channel_sync_task_item i JOIN channel_sync_task t ON t.id=i.task_id WHERE t.task_type='moboreader.preview_refresh.v1' AND i.status IN ('pending','processing')) AS "previewBacklog"`);
 return {at:new Date().toISOString(),role,articles,previews,tasks,refreshes,latestSitemap:latest,totals:totals[0]};},{isolationLevel:'RepeatableRead',timeout:120000});console.log(JSON.stringify(x));}
main().catch(()=>{console.error(JSON.stringify({status:'STOP',code:'account_read_failed'}));process.exitCode=1}).finally(()=>db.$disconnect());
