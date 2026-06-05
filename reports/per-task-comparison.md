# Per-Task Comparison

Updated: 2026-06-05

This table compares the current 20-task SWE-Smith evidence set across Vercel, Modal, and Daytona in cold and warm modes.

task | vercel cold | vercel warm | modal cold | modal warm | daytona cold | daytona warm
--- | --- | --- | --- | --- | --- | ---
adrienverge__yamllint.8513d9b9.combine_file__26dq3p0r | pass 38.3s | pass 40.0s | pass 45.4s | pass 47.9s | pass 51.8s | pass 36.2s
agronholm__typeguard.b6a7e438.func_basic__x36wmlww | pass 33.7s | pass 39.2s | pass 40.5s | pass 31.8s | pass 39.1s | pass 25.8s
amueller__word_cloud.ec24191c.func_basic__b5q81acm | fail 42.5s | fail 49.7s | pass 46.4s | pass 38.1s | pass 29.3s | pass 23.9s
andialbrecht__sqlparse.e57923b3.lm_rewrite__v1mce7cy | pass 28.9s | pass 28.2s | pass 62.2s | pass 44.7s | pass 30.7s | pass 22.4s
benoitc__gunicorn.bacbf8aa.func_basic__460nzix1 | pass 29.1s | pass 29.2s | pass 38.9s | pass 38.7s | pass 24.9s | pass 20.6s
bottlepy__bottle.a8dfef30.func_basic__a0p07t6t | pass 31.0s | pass 37.6s | pass 31.0s | pass 38.9s | pass 31.6s | pass 19.4s
cantools__cantools.0c6a7871.combine_file__2yrjny26 | pass 114.3s | pass 114.6s | pass 52.3s | pass 39.6s | pass 31.3s | pass 28.4s
cantools__cantools.0c6a7871.func_basic__d9efqrpd | pass 111.8s | pass 120.5s | pass 46.1s | pass 49.0s | pass 22.7s | pass 25.6s
cantools__cantools.0c6a7871.func_pm_ctrl_invert_if__guvo4gx7 | pass 118.7s | pass 114.5s | pass 47.1s | pass 46.2s | pass 33.7s | pass 30.7s
cknd__stackprinter.219fcc52.combine_file__gymp2mmm | pass 28.6s | pass 25.9s | pass 39.5s | pass 39.4s | pass 30.3s | pass 42.5s
conan-io__conan.86f29e13.combine_file__7tlw062n | pass 33.1s | pass 31.4s | pass 48.5s | pass 49.5s | pass 27.4s | pass 24.6s
conan-io__conan.86f29e13.pr_11412 | fail 35.1s | fail 33.6s | fail 105.7s | fail 102.4s | pass 76.7s | pass 61.0s
conan-io__conan.86f29e13.pr_15965 | fail 32.2s | fail 31.1s | pass 42.0s | pass 35.2s | pass 69.4s | pass 32.0s
dask__dask.5f61e423.combine_module__dkp16syb | fail 134.2s | fail 142.0s | pass 179.7s | pass 136.7s | pass 105.2s | pass 109.2s
davidhalter__parso.338a5760.func_basic__ru17a9em | pass 38.3s | pass 36.2s | pass 39.5s | pass 33.8s | pass 22.1s | pass 33.8s
dbader__schedule.82a43db1.lm_rewrite__rasm7146 | pass 26.3s | pass 26.3s | pass 22.1s | pass 29.4s | pass 19.2s | pass 16.2s
encode__starlette.db5063c2.combine_file__hrjivx2s | fail 32.1s | fail 29.7s | fail 31.6s | fail 52.9s | pass 32.1s | pass 41.5s
encode__starlette.db5063c2.func_basic__vehyiaux | fail 32.3s | fail 31.8s | fail 41.7s | fail 43.4s | pass 30.7s | pass 33.5s
facebookresearch__fvcore.a491d5b9.lm_rewrite__yldgp998 | fail 26.7s | fail 34.9s | pass 38.9s | pass 36.3s | fail 36.0s | fail 47.5s
facelessuser__soupsieve.a8080d97.func_basic__32q3kq07 | pass 27.4s | pass 27.1s | pass 46.3s | pass 34.4s | pass 21.1s | pass 23.6s

## Reading The Table

- Times are measured wall-clock task elapsed seconds from each provider result JSON.
- A passing task means the solver exited cleanly and the verifier accepted the patched tree.
- Failures are not normalized away here. For the apples-to-apples comparison, use [cross-vendor-comparison.md](cross-vendor-comparison.md).
- Failure details are summarized in [failure-modes-tradeoffs.md](failure-modes-tradeoffs.md).
