# @zdx8637/dshmobile-bridge

**寮€绠卞嵆鐢ㄧ殑鎵嬫満杩滅▼妗ユ帴**锛氫竴鏉″懡浠ゅ畨瑁咃紝鏃犻渶浠讳綍缃戠粶閰嶇疆銆佹棤闇€鏈湴琛ヤ竵锛?閲嶅惎 dsh 鍚庡乏渚ф爮鍗冲嚭鐜板父椹讳簩缁寸爜闈㈡澘锛堣法骞冲彴锛孌SH 鍗囩骇鍏嶇柅锛夈€?
- **甯搁┗浜岀淮鐮?*锛圵eb 宸︿晶鏍忓簳閮ㄧ澶村脊绐楋級锛氫笌鐧诲綍鎬佹棤鍏筹紝姘歌繙鍙壂鈥斺€?  路 鐢佃剳宸茬櫥褰?鈫?鎵嬫満锛堝摢鎬曟湭鐧诲綍锛夋壂鐮佺洿鎺ョ櫥褰曞悓璐﹀彿锛?  路 鐢佃剳鏈櫥褰?鈫?鎵嬫満锛堝凡鐧诲綍锛夋壂鐮佹巿鏉冿紝鐢佃剳鑷姩鐧诲綍锛?- **bridge 瀛愯繘绋嬪畧鎶?*锛氳处鍙峰瘑鐮佹ā寮忔垨鎵嬫満鎺堟潈 token 妯″紡锛堟棤瀵嗙爜鐩磋繛锛?01 鑷姩鍒锋柊锛夛紱
- 鎵嬫満绔竴鐮佷笁鐢細寰俊鎵?涓嬭浇 App銆佺浉鏈烘壂=璺?App 閰嶅銆丄pp 鍐呮壂=鐩存帴鐧诲綍/鎺堟潈銆?
<p align="center"><img src="https://raw.githubusercontent.com/zdx8637-gitdog/dshmobile/main/docs/images/plugin-panel.jpg" width="480" alt="DSH 鎻掍欢闈㈡澘锛堝乏渚ф爮甯搁┗浜岀淮鐮侊級"/></p>

## 瀹夎

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @zdx8637/dshmobile-bridge@latest
# 閲嶅惎 dsh 鍚庯紝Web 宸︿晶鏍忓簳閮ㄥ嚭鐜?鈻?绠ご锛岀偣寮€鍗抽厤缃潰鏉?```

鍓嶇疆锛氭湰鏈洪渶瑕?`pnpm`锛坄dsh plugin` 瀛愬懡浠や緷璧栧畠锛沗corepack enable` 鎴?`npm i -g pnpm`锛夈€?
鎵嬫満 App锛氭壂鎻忛潰鏉夸簩缁寸爜 鈫?钀藉湴椤典笅杞?APK锛堟垨浠?[鍙戝竷椤礭(https://github.com/zdx8637-gitdog/dshmobile/releases)鑾峰彇锛夈€?
## 鍏嶈ˉ涓侊細闈㈡澘璧版湰鍦伴€氶亾

DSH 0.1.0-rc.6 榛樿涓嶅悜娴忚鍣ㄦ毚闇茬涓夋柟 settings 鍛藉悕绌洪棿锛堜笂娓告爣娉ㄤ负
deferred work锛夈€傛湰鎻掍欢**涓嶄緷璧栬閫氶亾**锛氶潰鏉夸笌瀹夸富閫氳繃 `127.0.0.1:17653`
鐨勬湰鍦?HTTP 閫氫俊锛堣疆璇㈢姸鎬?+ 涓嬪彂鍔ㄤ綔锛孋ORS 浠呮斁琛屾湰鏈烘潵婧愶級锛屽洜姝?
- 涓€鏉″懡浠ゅ畨瑁呭嵆鐢紝**鏃犻渶浠讳綍鏈湴琛ヤ竵**锛?- Windows/macOS/Linux 閫氱敤锛?- DSH 鍗囩骇涓嶅彈褰卞搷锛堝巻鍙茬増鏈?0.1.0-beta.3 鍙婃洿鏃╅渶瑕?`scripts/expose-settings-namespace.ps1` 琛ヤ竵锛屽凡搴熷純锛夈€?
## DSH 鏂扮増锛坴0.1.5+锛夐€傞厤涓庡弻鍗忚鍏煎

v0.1.5 璧?DSH 缁欐湰鍦?Web 鏈嶅姟鍔犱簡娴忚鍣ㄤ細璇濋壌鏉冿紙`dsh web` 鎵撳嵃鐨?URL 閲屽甫
杩涚▼绾?launch token 鈫?娴忚鍣ㄦ崲浼氳瘽 Cookie锛宍/api` 鍏ㄩ儴璇锋眰鏍￠獙锛夛紝骞舵妸 RPC
鍗忚鍗囩骇涓?Typert 绔偣锛坄session/list`銆乣{args}` 杞借嵎銆乣/api/remote.mux`
娴佸鐢ㄣ€乣$events` 瀹℃壒/鎻愰棶鐎戝竷锛夈€傛彃浠?0.1.0-beta.17 璧疯嚜鍔ㄩ€傞厤锛?
- host 鍗婅竟缁?`ctx.connection.authenticatedUrl()` 鍙?launch token 浜ょ粰妗ュ瓙杩涚▼锛?- 妗ヤ竴娆℃€ф崲 Cookie锛圚MAC 绛惧悕銆?0 澶╂湁鏁堬級锛岀紦瀛樹簬鐘舵€佺洰褰曘€?01 鑷姩閲嶉摳锛?  鎵€鏈?`/api` 璇锋眰涓?WS 鍗囩骇鎼哄甫 Cookie锛?- 浼氳瘽/宸ヤ綔鍖?鍛戒护绔偣鏄犲皠鍒版柊鍗忚锛屼簨浠舵祦璧?`/api/remote.mux` 鐨?  `session/follow` + `workspace/follow` + `session/control`锛屽鎵?鎻愰棶璧?  `$events` + `$events/result`銆?
**鍙屽崗璁嚜閫傚簲锛?.1.0-beta.18 璧凤級**锛氭ˉ鍚姩鏃惰嚜鍔ㄦ帰娴?DSH 浠ｉ檯鈥斺€旀柊鐗堣蛋涓婅堪
v2 鍗忚锛涙棫鐗?DSH 鑷姩鍥為€€ legacy 鍗忚锛堢偣鍙风鐐广€佽８ payload銆乣events.mux`/
`events.host` 鍙屾祦銆乣/api/respond` 搴旂瓟銆佹棤閴存潈鐩磋繛锛屼笌 beta.16 琛屼负涓€鑷达級銆?鍥犳**鍗囩骇椤哄簭鏃犲叧**锛氬厛鍗囨彃浠躲€佸悗鍗?DSH锛屾垨鍙嶄箣锛屽潎鍏ㄧ▼鍙敤锛涙棫鐗?DSH 鐢ㄦ埛
涓嶅崌绾т篃鐓у父宸ヤ綔銆?
鑷鑴氭湰锛歚node scripts/smoke-dsh-v2.mjs`锛堜豢鏂扮増 DSH 鍏ㄩ摼璺級銆?`node scripts/smoke-dsh-legacy.mjs`锛堜豢鏃х増 DSH 鍏ㄩ摼璺級銆?`node scripts/probe-real-dsh.mjs`锛堝杩愯涓湡瀹?DSH 鍙楠岃瘉锛岄渶鏈満娴忚鍣?宸茬櫥褰曡繃涓€娆?Web 闈㈡澘浠ョ敓鎴愮鍚嶅瘑閽ワ級銆?
## relay 璇存槑

鎻掍欢榛樿杩炴帴 `https://www.deepseek-claudex.cn`锛堜綔鑰呰嚜钀?relay锛氳处鍙锋敞鍐屻€?璁惧绠＄悊銆佹秷鎭矾鐢卞潎璧拌鏈嶅姟鍣級銆備篃鍙嚜寤猴細瑙佷富浠撳簱
[dshmobile](https://github.com/zdx8637-gitdog/dshmobile) 鐨?`relay/` 鐩綍涓?`dsh-remote/docs/04-operations.md`锛岀劧鍚庡湪闈㈡澘閲屾妸 relay 鍦板潃鏀规垚浣犺嚜宸辩殑銆?
## 寮€鍙?
```sh
npm install
node scripts/build.mjs                  # 浜у嚭 lib/index.js + lib/client.js
node scripts/smoke-host.mjs <u> <p>     # 璐﹀彿瀵嗙爜妯″紡鍐掔儫
node scripts/smoke-grant.mjs <u> <p>    # 鎵嬫満鎺堟潈妯″紡鍐掔儫
```

瀹屾暣涓夌锛堟墜鏈?App / relay / 鍗忚锛夎涓讳粨搴?[zdx8637-gitdog/dshmobile](https://github.com/zdx8637-gitdog/dshmobile)銆?
## License

MIT

