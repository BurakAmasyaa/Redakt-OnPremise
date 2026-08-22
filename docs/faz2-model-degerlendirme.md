# Faz 2 Türkçe NER model değerlendirmesi

Değerlendirme, gerçek kişi/kurum adları içeren 10 Türkçe cümlede 18 hedef varlık
üzerinde tam metin ve doğru tür eşleşmesiyle yapıldı. Test örnekleri yalnızca test
verisidir; uygulama kaynak kodunda isim listesi veya sözlük bulunmaz.

| Model | TP | FP | FN | F1 |
|---|---:|---:|---:|---:|
| `akdeniz27/bert-base-turkish-cased-ner` (FP32) | 16 | 2 | 2 | 0,8889 |
| `akdeniz27/bert-base-turkish-cased-ner` (q4) | 16 | 2 | 2 | 0,8889 |
| `akdeniz27/convbert-base-turkish-cased-ner` (FP32) | 16 | 3 | 2 | 0,8649 |
| `savasy/bert-base-turkish-ner-cased` (FP32) | 15 | 5 | 3 | 0,7895 |

Seçilen sürüm `akdeniz27/bert-base-turkish-cased-ner` q4'tür. Aynı testte FP32
çıktısını korurken daha küçük indirme/bellek maliyeti sundu; ConvBERT'ten daha az
parçalı varlık üretti ve Savasy modelinden daha yüksek kesinlik sağladı.

## Dürüst sonuç

- 18 hedefin 16'sı doğru metin ve doğru türle yakalandı.
- `Sabiha Gökçen` tam varlık olarak kaçtı; model yalnızca `Gökçen` parçasını verdi.
- `Mavi` yakalandı ancak kurum yerine kişi olarak sınıflandırıldı.
- Negatif kontroller `Merkez Ofis` ve `İnsan Kaynakları` için bulgu üretilmedi.

Model çıktıları bu nedenle her zaman **muhtemel** bölümünde gösterilir.
