# CuratedTrading

CuratedTrading is a discovery and commerce layer for **big, bulk, industrial, unusual, and high-value inventory**.

The initial marketplace lane focuses on eBay inventory such as:

- pallet and wholesale lots
- heavy equipment and construction machinery
- forklifts, loaders, excavators, cranes, and attachments
- commercial vehicles and trailers
- containers, material handling, and industrial surplus
- agricultural equipment
- unusual large-format or high-ticket assets

## Architecture

- **Storefront:** GitHub Pages at `curatedtrading.com`
- **Marketplace gateway:** Node/Express on the HDP VPS
- **Public API:** `api.curatedtrading.com`
- **VPS runtime:** `C:\HDP\CuratedTrading\ebay`
- **Discovery source:** eBay Browse API
- **Commercial attribution:** eBay Partner Network-compatible outbound URLs

CuratedTrading is intentionally different from UltraHype: UltraHype follows what is hot; CuratedTrading hunts what is **large, unusual, valuable, and harder to discover**.
