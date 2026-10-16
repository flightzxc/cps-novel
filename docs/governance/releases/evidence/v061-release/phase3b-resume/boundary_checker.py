"""One-off read-only public checker. Receives protected codes in memory only."""
import re,json,html,collections
from html.parser import HTMLParser

def normalize(text):
 text=html.unescape(text)
 return re.sub(re.escape(chr(92)+'u')+r'([0-9a-fA-F]{4})',lambda m:chr(int(m[1],16)),text)
def mask_digits(value):return re.sub('[0-9]','#',value)
def boundary(code):return re.compile(r'(?<![0-9])'+re.escape(code)+r'(?![0-9])')
class Positions(HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.stack=[];self.chunks=[]
 def handle_starttag(self,tag,attrs):
  for name,value in attrs:
   if value:self.chunks.append(({'positionCategory':'attribute','attributeName':mask_digits(name),'tag':mask_digits(tag)},value))
  if tag not in {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}:self.stack.append(tag)
 def handle_startendtag(self,tag,attrs):self.handle_starttag(tag,attrs);self.handle_endtag(tag)
 def handle_endtag(self,tag):
  if tag in self.stack:self.stack=self.stack[:len(self.stack)-1-self.stack[::-1].index(tag)]
 def handle_comment(self,data):self.chunks.append(({'positionCategory':'html_comment','tag':'comment'},data))
 def handle_data(self,data):
  tag=self.stack[-1] if self.stack else ''
  self.chunks.append(({'positionCategory':'script_json' if tag=='script' else 'style' if tag=='style' else 'visible_text','tag':mask_digits(tag)},data))
def script_key(text,offset):
 # Only expose a key name, never its value or the surrounding JSON.
 keys=list(re.finditer(r'"([A-Za-z0-9_.:-]{1,100})"\s*:',text[:offset].replace(chr(92)+'"','"')))
 return mask_digits(keys[-1][1]) if keys else 'unresolved'
def scan(codes,body,kind='html',article_id=None,card=None):
 normalized=normalize(body);parsed=Positions()
 if kind!='location':parsed.feed(normalized)
 else:parsed.chunks=[({'positionCategory':'attribute','attributeName':'Location','tag':'http_header'},normalized)]
 contexts=[];boundary_total=0;forbidden=0;accidental=0;allowed=0;matched_values=set();accidental_values=set()
 for owner,code in codes.items():
  pat=boundary(code);hits=list(pat.finditer(normalized));total=len(list(re.finditer(re.escape(code),normalized)));embedded=total-len(hits);accidental+=embedded
  if embedded:accidental_values.add(code)
  if not hits:continue
  matched_values.add(code);boundary_total+=len(hits);permitted=kind=='interstitial' and owner==article_id
  if permitted:allowed+=len(hits)
  else:forbidden+=len(hits)
  for position,text in parsed.chunks:
   for hit in pat.finditer(text):
    c={'ownership':'self' if owner==article_id else 'other','allowedOwnInterstitial':permitted,**position}
    if c['positionCategory']=='script_json':c['scriptJsonKey']=script_key(text,hit.start())
    contexts.append(c)
 # Retain only metadata with all digits masked in names. No excerpt or code value.
 out={'checkedCodes':len(codes),'matchingRule':'(?<![0-9])CODE(?![0-9])','boundaryOccurrences':boundary_total,'boundaryMatchingCodeValues':len(matched_values),'forbiddenBoundaryOccurrences':forbidden,'allowedOwnInterstitialOccurrences':allowed,'accidentalCoincidenceOccurrences':accidental,'accidentalCoincidenceCodeValues':len(accidental_values),'boundaryContexts':contexts,'rawCodeValuesPrinted':0}
 if kind=='interstitial':out.update(codeCardMatches=card==codes.get(article_id),ownCodePresent=bool(boundary(codes[article_id]).search(normalized)))
 # On a forbidden hit, redact EVERY protected code substring, including embedded
 # coincidences, from normalized HTML before any persistence.
 snapshot=None
 if forbidden:
  snapshot=normalized
  for code in sorted(set(codes.values()),key=len,reverse=True):snapshot=snapshot.replace(code,'[CODE]')
  snapshot=re.sub(r'0x4[A-Za-z0-9_-]+','[TURNSTILE_REDACTED]',snapshot)
  assert not any(code in snapshot for code in codes.values())
 return out,snapshot
