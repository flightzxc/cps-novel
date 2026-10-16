from pathlib import Path
import json,subprocess,re,hashlib
r=Path.cwd();o=r/'.tmp/v061-release/phase3a';ev=r/'docs/governance/releases/evidence/plotnovel-bulk-publish-2026-10-15';data=json.loads((ev/'final/B47-failed-books.json').read_text());print('B47_SHAPE='+str(type(data).__name__))
rows=data if isinstance(data,list) else data.get('failedBooks',data.get('books',[]));assert len(rows)==58
(o/'failed-books.json').write_text(json.dumps(rows,indent=2)+'\n')
for name in ['render','article']:
 s=subprocess.check_output(['git','show','493eb23b:src/lib/seo/template/'+name+'.ts'],text=True)
 s=re.sub(r'from "\./([^"/]+)"',lambda m:'from "'+('/tmp/v060-render.ts' if name=='article' and m[1]=='render' else '/app/src/lib/seo/template/'+m[1]+'.ts')+'"',s)
 (o/('v060-'+name+'.ts')).write_text(s)
s=(ev/'threshold-review/render-only.ts.txt').read_text()
s=s.replace("const db=new PrismaClient();","const {renderArticleDraft:legacyRender}=req('/tmp/v060-article.ts');\nconst {buildNovelTemplateValues}=req('./src/lib/seo/template/values.ts');\nconst db=new PrismaClient();")
s=s.replace("meta.commit!=='493eb23b034b0410780228535b3e293e4ee91f9a'","meta.commit!=='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'||meta.version!=='0.6.1'")
a=s.index(" const bytes=readFileSync(");b=s.index(' const result=await',a)
s=s[:a]+" const expected=JSON.parse(readFileSync('/tmp/v061-failed-books.json','utf8'));\n const ids=expected.map((x:{novelId:string})=>x.novelId);\n const m={appId:'00de5521-d075-4472-87eb-cc5d1732f4d0'};\n"+s[b:]
s=s.replace("string_starts_with:'plotnovel-bulk-20261015-w1-c'","string_starts_with:'plotnovel-bulk-20261015-w'").replace("if(rows.length!==12||rows.some((i:{targetId:string})=>!ids.includes(i.targetId)))","if(rows.length!==58||rows.some((i:{id:string,targetId:string})=>!ids.includes(i.targetId)||expected.find((x:{novelId:string})=>x.novelId===i.targetId)?.itemId!==i.id))")
a="    renderNovelArticleDraft({source,templateKey:template.templateKey,novel,previewChapterCount,promoPublicRedirectCode:promo.promo.publicRedirectCode,promoTheaterConfig:promo.promo.channelApp?.config});\n    results.push({...base,renderStatus:'success'});"
b="""    let originalFailure=null;
    try{legacyRender(source,buildNovelTemplateValues({title:novel.title,description:novel.description,coverUrl:novel.coverUrl,totalChapterCount:novel.totalChapterCount,previewChapterCount,promoRedirectUrl:'/go/'+promo.promo.publicRedirectCode}),{templateKey:template.templateKey,novelId:novel.id});}
    catch(e){if(!isTemplateRenderError(e))throw Error('non_template_render_error');originalFailure={code:safe(e.code),slot:safe(e.slot),field:safe(e.field),constraint:safe(e.constraint)};}
    if(!originalFailure)throw Error('original_failure_not_reproduced');
    renderNovelArticleDraft({source,templateKey:template.templateKey,novel,previewChapterCount,promoPublicRedirectCode:promo.promo.publicRedirectCode,promoTheaterConfig:promo.promo.channelApp?.config});
    results.push({...base,originalFailure,renderStatus:'success'});"""
assert a in s;s=s.replace(a,b);(o/'render-only.ts').write_text(s)
print('RENDER_HELPERS_READY')
