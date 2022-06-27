## Installation

Add `npm.pkg.github.com` registry by create a file and named `.npmrc` in root folder:

```
@finhay:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=GITHUB_PERSONAL_TOKEN
registry=https://registry.npmjs.org/
```

```javascript
npm i @finhay/finhay-logger
```

## Usage:

Log a text message:

```javascript
const { logger } = require("@finhay/finhay-logger");

logger.info("This is test message");
```

To log a message contains an object:

```javascript
logger.info("Log object %o %s", { a: 1, b: 2 }, "extra text");
```

To log single object only:

```javascript
logger.info({ a: 1, b: 2 });
```

#### Referrence

[Logging in Microservice Architecture](https://www.linkedin.com/pulse/logging-microservice-architecture-alumnus-software-limited-1c)
