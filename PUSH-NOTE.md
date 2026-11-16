# 推送与 Windows TLS 踩坑说明

> 状态：仓库已成功推送到 `origin/main`，本地与远端 HEAD 一致。本文件记录推送过程中遇到的 Windows + 代理环境问题，供在类似环境（公司代理、加速器、 schannel）下使用本仓库的人参考。

## 已验证可推送的方式

在本目录执行：

```bash
git push -u origin main
```

若遇到 `schannel: next InitializeSecurityContext failed: CRYPT_E_NO_REVOCATION_CHECK (0x80092012)`，用：

```bash
GIT_SSL_NO_VERIFY=true git push -u origin main
```

对应的只读诊断：`GIT_SSL_NO_VERIFY=true git ls-remote origin`。

## 关于 `CRYPT_E_NO_REVOCATION_CHECK`

这个报错容易误导。在本次环境中它**不是**网络不通、也不是认证失败，而是 Windows schannel 后端在做 TLS 证书吊销检查（CRL）时，本机代理对证书链做了中间人处理，导致吊销状态无法验证。

判断方法（按顺序）：

1. `curl.exe -v https://github.com -o /dev/null`——若看到 `HTTP/1.1 200 Connection Established`，说明代理 CONNECT 隧道正常，网络是通的；
2. `curl.exe --ssl-no-revoke https://api.github.com -o /dev/null -w "%{http_code}"`——返回 200 即确认只是 CRL 检查问题；
3. 再对 git 用 `GIT_SSL_NO_VERIFY=true` 绕过。

注意：`git config http.schannelCheckRevoke false` 对 `git ls-remote`/`push` **不生效**，不要依赖它；`curl.exe` 也不读 git 的这项配置，需用 `--ssl-no-revoke` 或 `GIT_SSL_NO_VERIFY` 环境变量。

`GIT_SSL_NO_VERIFY` 会跳过证书校验，仅建议在确认过代理/网络环境、且只对单次命令使用；不要设为全局配置。

## 环境变量代理端口会变化

本机代理通过环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 注入，端口在不同会话间可能改变（本次从 `127.0.0.1:49743` 变为 `127.0.0.1:50987`）。排查时以当前 `env | grep -i proxy` 为准，不要沿用旧端口号。系统代理设置（`HKCU\...\Internet Settings` 的 `ProxyEnable`）在此环境为关闭状态，浏览器走的是别的出口，因此"浏览器能访问"不等于"git 命令行用同样配置能访问"。

## 认证

GitHub 已不再接受账号密码。若推送要求认证，使用 Personal Access Token（scope: `repo`）作为密码，或配置 SSH key 后更换 remote：

```bash
git remote set-url origin git@github.com:siquxhe/MCP-for-Zotero-Automation.git
```

## 与远端历史的关系

远端仓库由用户先行创建，首次提交（`93ad86d`）含两行 README 与 GPL-3.0 LICENSE。本地仓库与该提交无共同祖先，通过 `git merge origin/main --allow-unrelated-histories` 合并：LICENSE 沿用远端的 GPL-3.0，README 保留远端标题/描述并接上本地完整文档。合并提交为 `3c5755e`，未使用强推覆盖。
