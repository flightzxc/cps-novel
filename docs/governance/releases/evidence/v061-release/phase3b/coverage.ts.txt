import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {randomInt} from 'node:crypto';
const req=createRequire('/app/package.json'),{PrismaClient}=req('@prisma/client');
const {createSitemapFamilyBuilder}=req('./src/lib/seo/sitemap.ts');
const {buildArticlePath}=req('./src/lib/slug/article-path.ts');
const {getStaticSitemapCurrentDir}=req('./src/lib/seo/static-sitemap-cache.ts');
const db=new PrismaClient();
async function main(){
 const targets=JSON.parse(fs.readFileSync('/tmp/v061-account-input.json','utf8'));
 const m=JSON.parse(fs.readFileSync('/tmp/plotnovel-b47-20261016-manifest.json','utf8'));
 const result=await db.$transaction(async(tx:typeof db)=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const [role]=await tx.$queryRawUnsafe("SELECT current_user::text role,current_setting('transaction_read_only') readonly");if(role.role!=='web_app'||role.readonly!=='on')throw Error('role');
  const articles=await tx.article.findMany({where:{status:'published',deletedAt:null,promoLink:{channelAppId:m.appId}},select:{id:true,novelId:true,locale:true,slug:true,publicPageShortId:true,promoLink:{select:{publicRedirectCode:true}}}});
  const extra=await tx.article.findMany({where:{status:'published',deletedAt:null,novel:{sourceItems:{some:{id:{in:targets.sourceItemIds}}}}},select:{id:true,novelId:true,locale:true,slug:true,publicPageShortId:true}});
  const extraBooks=new Set(extra.map((a:any)=>'https://pulsenovels.com'+buildArticlePath({locale:a.locale,slug:a.slug,shortId:a.publicPageShortId})));
  const books=new Set(articles.map((a:any)=>'https://pulsenovels.com'+buildArticlePath({locale:a.locale,slug:a.slug,shortId:a.publicPageShortId})));
  // Same production visibility, chapter window and nonempty-content rules as the refresh worker.
  const family=await createSitemapFamilyBuilder(tx)({type:'novelpage',locale:'en'});
  const expectedBooks=new Set<string>(),expectedChapters=new Set<string>();
  for(const f of family)for(const e of f.entries){if(books.has(e.loc))expectedBooks.add(e.loc);else if(books.has(e.loc.split('/chapter/')[0]))expectedChapters.add(e.loc);}
  const dir=getStaticSitemapCurrentDir(),index=fs.readFileSync(path.join(dir,'sitemap.xml'),'utf8');
  const files=[...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x:any)=>new URL(x[1]).pathname.split('/').pop()).filter((x:string)=>/^site_novelpage_en(?:_\d+)?\.xml$/.test(x));
  const actual=new Set<string>();for(const file of files){const xml=fs.readFileSync(path.join(dir,'sitemap',file),'utf8');for(const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g))actual.add(match[1].replaceAll('&amp;','&'));}
  const extraExpectedBooks=new Set<string>(),extraExpectedChapters=new Set<string>();for(const f of family)for(const e of f.entries){if(extraBooks.has(e.loc))extraExpectedBooks.add(e.loc);else if(extraBooks.has(e.loc.split('/chapter/')[0]))extraExpectedChapters.add(e.loc);}
  const extraMissingBooks=[...extraExpectedBooks].filter(u=>!actual.has(u)),extraMissingChapters=[...extraExpectedChapters].filter(u=>!actual.has(u));
  const missingBooks=[...expectedBooks].filter(u=>!actual.has(u)),missingChapters=[...expectedChapters].filter(u=>!actual.has(u));
  const manifestIds=new Set(m.waves.flatMap((w:any)=>w.chunks.flatMap((c:any)=>c.novelIds))),created=articles.filter((a:any)=>manifestIds.has(a.novelId));
  const createdBookUrls=new Set(created.map((a:any)=>'https://pulsenovels.com'+buildArticlePath({locale:a.locale,slug:a.slug,shortId:a.publicPageShortId})));
  const newChapterPages=[...expectedChapters].filter(u=>createdBookUrls.has(u.split('/chapter/')[0])).length;
  const indices=new Set<number>();while(indices.size<3)indices.add(randomInt(created.length));
  const samples=[...indices].map(i=>{const a=created[i];return {articleId:a.id,novelId:a.novelId,bookPath:buildArticlePath({locale:a.locale,slug:a.slug,shortId:a.publicPageShortId}),goCode:a.promoLink.publicRedirectCode}});
  return {extraArticleCount:extra.length,extraBuilderBooks:extraExpectedBooks.size,extraExpectedChapters:extraExpectedChapters.size,extraMissingBooks:extraMissingBooks.length,extraMissingChapters:extraMissingChapters.length,at:new Date().toISOString(),databaseRole:role.role,transactionReadOnly:role.readonly,publishedTotal:articles.length,newPublished:created.length,existingPublished:articles.length-created.length,newValidIndexableChapterPages:newChapterPages,existingValidIndexableChapterPages:expectedChapters.size-newChapterPages,expectedExisting:1977,originalBuilderBooks:expectedBooks.size,expectedValidIndexableChapters:expectedChapters.size,missingBookCount:missingBooks.length,missingChapterCount:missingChapters.length,unexpectedPlotChapterCount:[...actual].filter(u=>u.includes('/chapter/')&&books.has(u.split('/chapter/')[0])&&!expectedChapters.has(u)).length,goUrlsInNovelSitemaps:[...actual].filter(u=>u.includes('/go/')).length,allPublishedBooksAreCandidates:expectedBooks.size===articles.length,staticRelease:path.basename(fs.realpathSync(dir)),shards:files.length,samples};
 },{isolationLevel:'RepeatableRead',timeout:120000});
 console.log(JSON.stringify(result));
}
main().catch(()=>{console.error(JSON.stringify({status:'STOP',code:'final_coverage_failed'}));process.exitCode=1}).finally(()=>db.$disconnect());
