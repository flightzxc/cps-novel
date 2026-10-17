import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const req=createRequire('/app/package.json');
const { PrismaClient }=req('@prisma/client');
const { selectActiveArticleTemplate,validateStoredArticleTemplate }=req('./src/server/article-templates/index.ts');
const { renderNovelArticleDraft,countPreviewChapters }=req('./src/server/content-creation/render-novel-article.ts');
const { resolveReadyPromoLinkForNovel }=req('./src/server/content-creation/promo.ts');
const { isTemplateRenderError }=req('./src/lib/seo/template/index.ts');
const {renderArticleDraft:legacyRender}=req('/tmp/v060-article.ts');
const {buildNovelTemplateValues}=req('./src/lib/seo/template/values.ts');
const db=new PrismaClient();
const safe=(x:unknown)=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(x)?x:null;
async function main(){
 const meta=JSON.parse(readFileSync('/app/.build-metadata.json','utf8'));
 if(process.cwd()!='/app'||meta.commit!=='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'||meta.version!=='0.6.1')throw Error('identity_refused');
 const expected=JSON.parse(readFileSync('/tmp/v061-failed-books.json','utf8'));
 const ids=expected.map((x:{novelId:string})=>x.novelId);
 const m={appId:'00de5521-d075-4472-87eb-cc5d1732f4d0'};
 const result=await db.$transaction(async(tx:typeof db)=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const [role]=await tx.$queryRawUnsafe("SELECT current_user::text role,current_setting('transaction_read_only') readonly");
  if(role.role!=='web_app'||role.readonly!=='on')throw Error('role_refused');
  const rows=await tx.genericTaskItem.findMany({where:{status:'failed',task:{taskType:'article.generate.v1',params:{path:['requestId'],string_starts_with:'plotnovel-bulk-20261015-w'}}},select:{id:true,targetId:true,taskId:true,error:true,payload:true},orderBy:{targetId:'asc'}});
  if(rows.length!==58||rows.some((i:{id:string,targetId:string})=>!ids.includes(i.targetId)||expected.find((x:{novelId:string})=>x.novelId===i.targetId)?.itemId!==i.id))throw Error('failed_scope_changed');
  const results=[];
  for(const item of rows){
   const novel=await tx.novel.findUnique({where:{id:item.targetId},select:{id:true,title:true,description:true,coverUrl:true,totalChapterCount:true,locale:true}});
   if(!novel||novel.locale!=='en')throw Error('novel_scope_refused');
   const p=item.payload,key=p.templateKey??p.templateKeysByLocale?.[novel.locale];
   const template=await selectActiveArticleTemplate(tx,{locale:novel.locale,applicableArticleType:'novel_article',...(key?{templateKey:key}:{})});
   if(!template)throw Error('template_missing');
   const promo=await resolveReadyPromoLinkForNovel(tx,novel.id);
   if(promo.outcome!=='ready'||await tx.promoLink.count({where:{id:promo.promo.id,channelAppId:m.appId}})!==1)throw Error('promo_scope_refused');
   const base={itemId:item.id,novelId:novel.id,taskId:item.taskId,persistedCode:safe(item.error?.code),persistedTemplateRenderError:item.error?.message==='Item finalize failed: TemplateRenderError',templateId:template.id,templateVersion:template.version};
   try{
    const source=validateStoredArticleTemplate(template),previewChapterCount=await countPreviewChapters(tx,novel.id);
    let originalFailure=null;
    try{legacyRender(source,buildNovelTemplateValues({title:novel.title,description:novel.description,coverUrl:novel.coverUrl,totalChapterCount:novel.totalChapterCount,previewChapterCount,promoRedirectUrl:'/go/'+promo.promo.publicRedirectCode}),{templateKey:template.templateKey,novelId:novel.id});}
    catch(e){if(!isTemplateRenderError(e))throw Error('non_template_render_error');originalFailure={code:safe(e.code),slot:safe(e.slot),field:safe(e.field),constraint:safe(e.constraint)};}
    if(!originalFailure)throw Error('original_failure_not_reproduced');
    renderNovelArticleDraft({source,templateKey:template.templateKey,novel,previewChapterCount,promoPublicRedirectCode:promo.promo.publicRedirectCode,promoTheaterConfig:promo.promo.channelApp?.config});
    results.push({...base,originalFailure,renderStatus:'success'});
   }catch(error){
    if(!isTemplateRenderError(error))throw Error('non_template_render_error');
    const e=error as Record<string,unknown>;
    results.push({...base,renderStatus:'failed',errorClass:'TemplateRenderError',code:safe(e.code),slot:safe(e.slot),field:safe(e.field),constraint:safe(e.constraint),tag:safe(e.tag),attribute:safe(e.attribute)});
   }
  }
  return {at:new Date().toISOString(),databaseRole:role.role,transactionReadOnly:role.readonly,mode:'render_only_no_persistence',count:rows.length,results};
 },{isolationLevel:'RepeatableRead',timeout:120000});
 console.log(JSON.stringify(result));
}
main().catch((e)=>{console.error(JSON.stringify({status:'STOP',code:'render_only_diagnostic_failed',errorClass:safe(e?.name),errorCode:safe(e?.code),guardReason:['identity_refused','manifest_refused','role_refused','failed_scope_changed','novel_scope_refused','template_missing','promo_scope_refused','non_template_render_error'].includes(e?.message)?e.message:null}));process.exitCode=1}).finally(()=>db.$disconnect());
