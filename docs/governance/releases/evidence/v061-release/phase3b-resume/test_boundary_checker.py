import unittest
from boundary_checker import scan
class BoundaryChecks(unittest.TestCase):
 def setUp(self):self.codes={'own':'123456','other':'654321'}
 def test_timestamp_is_accidental(self):
  x,s=scan(self.codes,'<img src="https://fixture.invalid/1234567890123.jpg">',article_id='own');self.assertEqual(x['forbiddenBoundaryOccurrences'],0);self.assertEqual(x['accidentalCoincidenceOccurrences'],1);self.assertIsNone(s)
 def test_all_digit_boundaries_not_word_boundaries(self):
  x,s=scan(self.codes,'<p>A123456B and 654321.</p>',article_id='own');self.assertEqual(x['forbiddenBoundaryOccurrences'],2);self.assertEqual({c['ownership'] for c in x['boundaryContexts']},{'self','other'});self.assertNotIn('123456',s);self.assertNotIn('654321',s)
 def test_attributes_and_json_keys_are_redacted(self):
  x,s=scan(self.codes,'<a data-42="654321"></a><script>{"key42":"123456"}</script>',article_id='own');self.assertEqual(x['forbiddenBoundaryOccurrences'],2);self.assertTrue(any(c.get('attributeName')=='data-##' for c in x['boundaryContexts']));self.assertTrue(any(c.get('scriptJsonKey')=='key##' for c in x['boundaryContexts']));self.assertNotIn('123456',s)
 def test_unicode_escape_is_scanned(self):
  x,s=scan(self.codes,'<p>'+chr(92)+'u003123456</p>',article_id='own');self.assertEqual(x['forbiddenBoundaryOccurrences'],1);self.assertNotIn('123456',s)
 def test_own_interstitial_policy_unchanged(self):
  x,s=scan(self.codes,'<div>123456</div>','interstitial','own','123456');self.assertEqual(x['forbiddenBoundaryOccurrences'],0);self.assertTrue(x['codeCardMatches']);self.assertTrue(x['ownCodePresent']);self.assertIsNone(s)
 def test_other_code_on_interstitial_stops_and_snapshot_redacts_all(self):
  x,s=scan(self.codes,'<div>123456 654321 1234567890123</div>','interstitial','own','123456');self.assertEqual(x['forbiddenBoundaryOccurrences'],1);self.assertEqual(x['accidentalCoincidenceOccurrences'],1);self.assertNotIn('123456',s);self.assertNotIn('654321',s)
 def test_location_is_scanned(self):
  x,s=scan(self.codes,'/go/654321/app','location','own');self.assertEqual(x['forbiddenBoundaryOccurrences'],1);self.assertEqual(x['boundaryContexts'][0]['attributeName'],'Location')
if __name__=='__main__':unittest.main(verbosity=2)
