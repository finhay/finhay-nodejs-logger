## Installation

Add `npm.pkg.github.com` registry by create a file and named `.npmrc`:

```
@finhay:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=GITHUB_PERSONAL_TOKEN
registry=https://registry.npmjs.org/
```

```javascript
npm i @finhay/winston-cw-logger
```

## Usage:

Log a text message:

```javascript
const { logger } = require("@finhay/winston-cw-logger");

logger.info("This is test message");
```

To log a message contains an object:

```javascript
logger.info("Log object %o %s", { a: 1, b: 2 }, "extra text");
```

#### Referrence

[Logging in Microservice Architecture](https://www.linkedin.com/pulse/logging-microservice-architecture-alumnus-software-limited-1c)
